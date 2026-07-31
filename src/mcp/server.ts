/**
 * tacp MCP server (stdio) — tools the agent can call during a Telegram session.
 *
 * Outbound Telegram (text / photo / file / speak) goes to the **worker API**
 * (HTTP over Unix socket). The daemon owns the bot token and topic map.
 * schedule_*: durable jobs under <repo>/.tacp/schedules/ (prompt + optional script).
 */
import { FastMCP } from "@prefecthq/fastmcp-ts/server";
import { z } from "zod";
import {
  cancelJob,
  createJob,
  listJobs,
  markJobDue,
} from "../schedules/store";
import {
  basenameOf,
  resolvePathUnderRepo,
  TELEGRAM_DOCUMENT_MAX_BYTES,
  TELEGRAM_PHOTO_MAX_BYTES,
} from "./repo-path";
import {
  workerSendDocument,
  workerSendMessage,
  workerSendPhoto,
  workerSpeak,
} from "./worker-api";

const server = new FastMCP({
  name: "tacp",
  version: "0.1.0",
});

function requireSessionEnv():
  | { ok: true; sessionKey: string; repoRoot: string }
  | { ok: false; error: string } {
  const sessionKey = process.env.TACP_SESSION_KEY?.trim();
  if (!sessionKey) {
    return {
      ok: false,
      error:
        "TACP_SESSION_KEY not set on MCP server " +
        "(tacp must inject session key via mcpServers env).",
    };
  }
  const repoRoot = process.env.TACP_REPO_ROOT?.trim();
  if (!repoRoot) {
    return {
      ok: false,
      error:
        "TACP_REPO_ROOT not set on MCP server " +
        "(tacp must inject repo root via mcpServers env).",
    };
  }
  return { ok: true, sessionKey, repoRoot };
}

server.tool(
  {
    name: "speak",
    description:
      "Speak to the user on Telegram: synthesizes TTS and sends a voice note now. " +
      "Use when the user asked for voice/spoken/TTS, or a short audible confirmation " +
      "is clearly better than text alone. Do not call on every message. " +
      "Do not use <<<speak>>> markers — this tool delivers audio directly.",
    input: z.object({
      text: z
        .string()
        .min(1)
        .describe("Text to speak. Keep it short and natural for TTS."),
    }),
  },
  async ({ text }) => {
    const cleaned = text.trim();
    if (!cleaned) {
      return "Nothing to speak (empty text).";
    }
    const sessionKey = process.env.TACP_SESSION_KEY?.trim();
    if (!sessionKey) {
      return (
        "speak failed: TACP_SESSION_KEY not set on MCP server " +
        "(tacp must inject session key via mcpServers env)."
      );
    }
    try {
      const ack = await workerSpeak({ sessionKey, text: cleaned });
      if (!ack.ok) return `speak failed: ${ack.error}`;
      return (
        ack.message ??
        `Sent Telegram voice note (${cleaned.length} chars${
          ack.bytes != null ? `, ${ack.bytes} bytes` : ""
        }).`
      );
    } catch (err) {
      return `speak failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
);

server.tool(
  {
    name: "update",
    description:
      "Send a short progress update to the operator on Telegram in this topic, right now. " +
      "Use while you are still working when a step takes a while, something important happened, " +
      "or the user should know you are making progress. Do not spam every tiny step. " +
      "Do not use this for the final answer — put that in your normal assistant reply. " +
      "Prefer 1–3 short sentences.",
    input: z.object({
      text: z
        .string()
        .min(1)
        .describe("Progress update for the operator (plain text)."),
    }),
  },
  async ({ text }) => {
    const cleaned = text.trim();
    if (!cleaned) return "Nothing to send (empty update).";
    const sessionKey = process.env.TACP_SESSION_KEY?.trim();
    if (!sessionKey) {
      return (
        "update failed: TACP_SESSION_KEY not set on MCP server " +
        "(tacp must inject session key via mcpServers env)."
      );
    }
    try {
      const ack = await workerSendMessage({
        sessionKey,
        text: cleaned,
        kind: "update",
      });
      if (!ack.ok) return `update failed: ${ack.error}`;
      return ack.message ?? `Sent Telegram update (${cleaned.length} chars).`;
    } catch (err) {
      return `update failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
);

server.tool(
  {
    name: "telegram_send",
    description:
      "Send a text message to the operator on Telegram in this topic (not TTS). " +
      "Use when you need to tell the user something mid-work that is not a progress ping " +
      "(e.g. need them to look at a link, or a clear intermediate result). " +
      "For short status pings prefer the update tool. Final answers still go in your normal reply.",
    input: z.object({
      text: z
        .string()
        .min(1)
        .describe("Message body for Telegram (plain text)."),
    }),
  },
  async ({ text }) => {
    const cleaned = text.trim();
    if (!cleaned) return "Nothing to send (empty message).";
    const sessionKey = process.env.TACP_SESSION_KEY?.trim();
    if (!sessionKey) {
      return (
        "telegram_send failed: TACP_SESSION_KEY not set on MCP server " +
        "(tacp must inject session key via mcpServers env)."
      );
    }
    try {
      const ack = await workerSendMessage({
        sessionKey,
        text: cleaned,
        kind: "message",
      });
      if (!ack.ok) return `telegram_send failed: ${ack.error}`;
      return ack.message ?? `Sent Telegram message (${cleaned.length} chars).`;
    } catch (err) {
      return `telegram_send failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);

server.tool(
  {
    name: "telegram_send_photo",
    description:
      "Send a photo to the operator on Telegram in this topic. " +
      "Path must be a file inside the session repo (relative to repo root or absolute under it). " +
      "Use for screenshots, plots, UI captures, design previews. Max ~10MB. " +
      "Prefer JPG/PNG/WebP. For PDFs, zips, logs, or other non-image files use telegram_send_file.",
    input: z.object({
      path: z
        .string()
        .min(1)
        .describe("Image path relative to repo root (or absolute under the repo)"),
      caption: z
        .string()
        .optional()
        .describe("Optional caption shown under the photo"),
    }),
  },
  async ({ path, caption }) => {
    const env = requireSessionEnv();
    if (!env.ok) return `telegram_send_photo failed: ${env.error}`;
    const resolved = resolvePathUnderRepo(env.repoRoot, path);
    if (!resolved.ok) return `telegram_send_photo failed: ${resolved.error}`;
    if (resolved.size > TELEGRAM_PHOTO_MAX_BYTES) {
      return (
        `telegram_send_photo failed: file too large (${resolved.size} bytes; ` +
        `max ${TELEGRAM_PHOTO_MAX_BYTES}). Use telegram_send_file for larger files ` +
        `or compress the image.`
      );
    }
    try {
      const ack = await workerSendPhoto({
        sessionKey: env.sessionKey,
        path: resolved.abs,
        filename: basenameOf(resolved.abs),
        ...(caption?.trim() ? { caption: caption.trim() } : {}),
      });
      if (!ack.ok) return `telegram_send_photo failed: ${ack.error}`;
      return (
        ack.message ??
        `Sent Telegram photo \`${resolved.rel}\` (${resolved.size} bytes).`
      );
    } catch (err) {
      return `telegram_send_photo failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);

server.tool(
  {
    name: "telegram_send_file",
    description:
      "Send a file/document to the operator on Telegram in this topic. " +
      "Path must be a file inside the session repo (relative to repo root or absolute under it). " +
      "Use for patches, logs, PDFs, archives, generated artifacts. Max ~50MB. " +
      "For images meant to be viewed inline, prefer telegram_send_photo.",
    input: z.object({
      path: z
        .string()
        .min(1)
        .describe("File path relative to repo root (or absolute under the repo)"),
      caption: z
        .string()
        .optional()
        .describe("Optional caption for the document"),
      filename: z
        .string()
        .optional()
        .describe("Optional download filename override (default: basename of path)"),
    }),
  },
  async ({ path, caption, filename }) => {
    const env = requireSessionEnv();
    if (!env.ok) return `telegram_send_file failed: ${env.error}`;
    const resolved = resolvePathUnderRepo(env.repoRoot, path);
    if (!resolved.ok) return `telegram_send_file failed: ${resolved.error}`;
    if (resolved.size > TELEGRAM_DOCUMENT_MAX_BYTES) {
      return (
        `telegram_send_file failed: file too large (${resolved.size} bytes; ` +
        `max ${TELEGRAM_DOCUMENT_MAX_BYTES}).`
      );
    }
    if (resolved.size === 0) {
      return `telegram_send_file failed: file is empty: ${path}`;
    }
    const name = filename?.trim() || basenameOf(resolved.abs);
    try {
      const ack = await workerSendDocument({
        sessionKey: env.sessionKey,
        path: resolved.abs,
        filename: name,
        ...(caption?.trim() ? { caption: caption.trim() } : {}),
      });
      if (!ack.ok) return `telegram_send_file failed: ${ack.error}`;
      return (
        ack.message ??
        `Sent Telegram file \`${name}\` from \`${resolved.rel}\` (${resolved.size} bytes).`
      );
    } catch (err) {
      return `telegram_send_file failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);

server.tool(
  {
    name: "schedule_create",
    description:
      "Create a durable scheduled job in this repo under .tacp/schedules/. " +
      "Requires a prompt (what the agent should do at fire time). " +
      "Optional script: path relative to repo root (must stay inside the repo). " +
      "kind=once needs runAt (ISO); kind=cron needs cronExpr (5-field m h dom mon dow). " +
      "Next-run is computed in UTC only (timezone is stored for later; prefer UTC). " +
      "When both day-of-month and day-of-week are restricted, either may match (classic cron OR). " +
      "Host fire is separate — this only persists the job.",
    input: z.object({
      name: z.string().min(1).optional().describe("Short label for the job"),
      prompt: z
        .string()
        .min(1)
        .describe("Full instruction for the agent when the job fires"),
      script: z
        .string()
        .min(1)
        .optional()
        .describe("Optional path relative to repo root (no .. escapes)"),
      kind: z.enum(["once", "cron"]).describe("once = single runAt; cron = recurring"),
      cronExpr: z
        .string()
        .min(1)
        .optional()
        .describe('5-field cron for kind=cron, e.g. "0 8 * * 1-5" (interpreted in UTC)'),
      runAt: z
        .string()
        .min(1)
        .optional()
        .describe("ISO timestamp for kind=once"),
      timezone: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Stored on the job; MVP next-run ignores this and always uses UTC — prefer \"UTC\"",
        ),
    }),
  },
  async (args) => {
    const env = requireSessionEnv();
    if (!env.ok) return `schedule_create failed: ${env.error}`;
    try {
      const job = await createJob(env.repoRoot, {
        sessionKey: env.sessionKey,
        prompt: args.prompt,
        kind: args.kind,
        ...(args.name != null ? { name: args.name } : {}),
        ...(args.script != null ? { script: args.script } : {}),
        ...(args.cronExpr != null ? { cronExpr: args.cronExpr } : {}),
        ...(args.runAt != null ? { runAt: args.runAt } : {}),
        ...(args.timezone != null ? { timezone: args.timezone } : {}),
      });
      let msg = `Created schedule ${job.id}\n${JSON.stringify(job, null, 2)}`;
      const tz = job.timezone ?? "UTC";
      if (tz !== "UTC" && tz !== "utc") {
        msg +=
          `\n\nWarning: timezone "${tz}" is stored but next-run is computed in UTC only for MVP. ` +
          `Use cron/runAt in UTC, or set timezone to "UTC".`;
      }
      return msg;
    } catch (err) {
      return `schedule_create failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);

server.tool(
  {
    name: "schedule_list",
    description:
      "List scheduled jobs for this session (TACP_SESSION_KEY) under .tacp/schedules/. " +
      "Pass all=true to list every job in the repo.",
    input: z.object({
      all: z
        .boolean()
        .optional()
        .describe("If true, list all jobs in the repo (not only this session)"),
    }),
  },
  async (args) => {
    const env = requireSessionEnv();
    if (!env.ok) return `schedule_list failed: ${env.error}`;
    try {
      const jobs = await listJobs(env.repoRoot, {
        sessionKey: env.sessionKey,
        all: args.all === true,
      });
      return JSON.stringify({ count: jobs.length, jobs }, null, 2);
    } catch (err) {
      return `schedule_list failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);

server.tool(
  {
    name: "schedule_cancel",
    description:
      "Soft-cancel a schedule by id for this session: sets enabled=false (file remains). " +
      "Only jobs owned by TACP_SESSION_KEY can be cancelled (pass all=true to cancel any in-repo job).",
    input: z.object({
      id: z.string().min(1).describe("Schedule job id"),
      all: z
        .boolean()
        .optional()
        .describe("If true, allow cancelling a job owned by another session in this repo"),
    }),
  },
  async ({ id, all }) => {
    const env = requireSessionEnv();
    if (!env.ok) return `schedule_cancel failed: ${env.error}`;
    try {
      const job = await cancelJob(env.repoRoot, id, {
        sessionKey: env.sessionKey,
        all: all === true,
      });
      return `Cancelled schedule ${job.id} (enabled=false)\n${JSON.stringify(job, null, 2)}`;
    } catch (err) {
      return `schedule_cancel failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);

server.tool(
  {
    name: "schedule_run_now",
    description:
      "Mark a schedule job due immediately (nextRunAt=now, enabled=true) so the acp-host " +
      "scheduler fires it on the next tick. Does not spawn the agent itself — host must be running. " +
      "Session-scoped unless all=true.",
    input: z.object({
      id: z.string().min(1).describe("Schedule job id"),
      all: z
        .boolean()
        .optional()
        .describe("If true, allow marking a job owned by another session in this repo"),
    }),
  },
  async ({ id, all }) => {
    const env = requireSessionEnv();
    if (!env.ok) return `schedule_run_now failed: ${env.error}`;
    try {
      const job = await markJobDue(env.repoRoot, id, {
        sessionKey: env.sessionKey,
        all: all === true,
      });
      return (
        `Marked schedule ${job.id} due (nextRunAt=${job.nextRunAt}). ` +
        `Host will fire on next tick.\n${JSON.stringify(job, null, 2)}`
      );
    } catch (err) {
      return `schedule_run_now failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);

await server.run();
