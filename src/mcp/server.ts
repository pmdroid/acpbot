/**
 * acpbot MCP server (stdio) — tools the agent can call during a Telegram session.
 *
 * Outbound Telegram (text / photo / file / speak) goes to the **worker API**
 * (HTTP over Unix socket). The daemon owns the bot token and topic map.
 * schedule_*: create / list / cancel / run-now durable delayed work.
 * agent_*: spawn / list / send / wait / kill parent-linked child agents (worktrees).
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
  workerAgentSpawn,
  workerAgentList,
  workerAgentKill,
  workerAgentSend,
  workerAgentWait,
} from "./worker-api";

const server = new FastMCP({
  name: "acpbot",
  version: "0.1.0",
});

function requireSessionEnv():
  | { ok: true; sessionKey: string; repoRoot: string }
  | { ok: false; error: string } {
  const sessionKey = process.env.ACPBOT_SESSION_KEY?.trim();
  if (!sessionKey) {
    return {
      ok: false,
      error:
        "ACPBOT_SESSION_KEY not set on MCP server " +
        "(acpbot must inject session key via mcpServers env).",
    };
  }
  const repoRoot = process.env.ACPBOT_REPO_ROOT?.trim();
  if (!repoRoot) {
    return {
      ok: false,
      error:
        "ACPBOT_REPO_ROOT not set on MCP server " +
        "(acpbot must inject repo root via mcpServers env).",
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
      "is clearly better than text alone. Do not call on every message.",
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
    const sessionKey = process.env.ACPBOT_SESSION_KEY?.trim();
    if (!sessionKey) {
      return (
        "speak failed: ACPBOT_SESSION_KEY not set on MCP server " +
        "(acpbot must inject session key via mcpServers env)."
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
      "PRIMARY way to keep the operator informed mid-turn. " +
      "Edits the single live “⏳ Working…” status bubble in this Telegram topic (not a new spam message). " +
      "Call this whenever a step takes more than a few seconds, you finish a major step, hit a snag, " +
      "or change plans — so the human sees progress without waiting for the final reply. " +
      "Prefer 1–3 short plain-text sentences (what happened / what next). " +
      "Do not use for the final answer (use your normal assistant reply). " +
      "Do not call on every tiny tool step. The bubble is removed when the turn ends.",
    input: z.object({
      text: z
        .string()
        .min(1)
        .describe(
          "Progress update the operator sees in the working bubble (plain text).",
        ),
    }),
  },
  async ({ text }) => {
    const cleaned = text.trim();
    if (!cleaned) return "Nothing to send (empty update).";
    const sessionKey = process.env.ACPBOT_SESSION_KEY?.trim();
    if (!sessionKey) {
      return (
        "update failed: ACPBOT_SESSION_KEY not set on MCP server " +
        "(acpbot must inject session key via mcpServers env)."
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
    const sessionKey = process.env.ACPBOT_SESSION_KEY?.trim();
    if (!sessionKey) {
      return (
        "telegram_send failed: ACPBOT_SESSION_KEY not set on MCP server " +
        "(acpbot must inject session key via mcpServers env)."
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
      "Create a scheduled job for later. " +
      "Requires a prompt (what to do when it fires). " +
      "kind=once needs runAt (ISO time); kind=cron needs cronExpr (5-field, UTC). " +
      "Optional script path must stay inside the session repo. " +
      "This only saves the job — the host fires it when due.",
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
        .describe("Optional in-repo script path"),
      kind: z.enum(["once", "cron"]).describe("once = single runAt; cron = recurring"),
      cronExpr: z
        .string()
        .min(1)
        .optional()
        .describe('5-field cron for kind=cron, e.g. "0 8 * * 1-5" (UTC)'),
      runAt: z
        .string()
        .min(1)
        .optional()
        .describe("ISO timestamp for kind=once"),
      timezone: z
        .string()
        .min(1)
        .optional()
        .describe('Prefer "UTC" (firing uses UTC)'),
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
      "List scheduled jobs for this session. " +
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
      "Cancel a schedule by id for this session (disables it; does not delete). " +
      "Pass all=true to cancel a job owned by another session in this repo.",
    input: z.object({
      id: z.string().min(1).describe("Schedule job id"),
      all: z
        .boolean()
        .optional()
        .describe("If true, allow cancelling a job owned by another session"),
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
      "Mark a schedule job due now so it fires on the next scheduler tick. " +
      "The host must be running. Session-scoped unless all=true.",
    input: z.object({
      id: z.string().min(1).describe("Schedule job id"),
      all: z
        .boolean()
        .optional()
        .describe("If true, allow a job owned by another session"),
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


server.tool(
  {
    name: "agent_spawn",
    description:
      "Spawn a child ACP agent in a NEW git worktree (never parent cwd). " +
      "Child is linked to this session as parent. Default headless=true: no new " +
      "Telegram topic; permissions and asks surface on this (parent) topic. " +
      "Set headless=false for a dedicated child topic. name is a short slug [a-z0-9-].",
    input: z.object({
      name: z
        .string()
        .min(1)
        .describe("Short child slug (a-z0-9-), becomes session …--name"),
      agent: z
        .string()
        .min(1)
        .optional()
        .describe("Agent id: grok-build | claude | codex | opencode"),
      role: z.string().min(1).optional().describe("Optional role label"),
      prompt: z
        .string()
        .min(1)
        .optional()
        .describe("Optional first prompt for the child"),
      headless: z
        .boolean()
        .optional()
        .describe(
          "Default true — no Telegram topic; permissions on parent. false = dedicated topic",
        ),
    }),
  },
  async (args) => {
    const env = requireSessionEnv();
    if (!env.ok) return `agent_spawn failed: ${env.error}`;
    try {
      const ack = await workerAgentSpawn({
        sessionKey: env.sessionKey,
        name: args.name,
        ...(args.agent ? { agent: args.agent } : {}),
        ...(args.role ? { role: args.role } : {}),
        ...(args.prompt ? { prompt: args.prompt } : {}),
        ...(args.headless !== undefined ? { headless: args.headless } : {}),
      });
      if (!ack.ok) return `agent_spawn failed: ${ack.error}`;
      return (
        (ack.message ?? "spawned") +
        (ack.record ? `\n${JSON.stringify(ack.record, null, 2)}` : "")
      );
    } catch (err) {
      return `agent_spawn failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);

server.tool(
  {
    name: "agent_list",
    description: "List child agents spawned from this session (parent hub).",
    input: z.object({}),
  },
  async () => {
    const env = requireSessionEnv();
    if (!env.ok) return `agent_list failed: ${env.error}`;
    try {
      const ack = await workerAgentList({ sessionKey: env.sessionKey });
      if (!ack.ok) return `agent_list failed: ${ack.error}`;
      return (
        (ack.message ?? "children") +
        `\n${JSON.stringify(ack.children ?? [], null, 2)}`
      );
    } catch (err) {
      return `agent_list failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);

server.tool(
  {
    name: "agent_send",
    description:
      "Send an A2A message to a child (slug or sessionKey) or to parent. " +
      "Sibling free-mesh is not allowed — parent is the hub.",
    input: z.object({
      to: z
        .string()
        .min(1)
        .describe('Child slug, full sessionKey, or "parent"'),
      message: z.string().min(1).describe("Message body delivered as a prompt"),
      mode: z.enum(["prompt", "steer"]).optional(),
    }),
  },
  async (args) => {
    const env = requireSessionEnv();
    if (!env.ok) return `agent_send failed: ${env.error}`;
    try {
      const ack = await workerAgentSend(
        {
          sessionKey: env.sessionKey,
          to: args.to,
          message: args.message,
          ...(args.mode ? { mode: args.mode } : {}),
        },
        // Nested parent/child turns can exceed the default 90s client timeout.
        { timeoutMs: 300_000 },
      );
      if (!ack.ok) return `agent_send failed: ${ack.error}`;
      // Include peer turn summary so the caller can use the answer (critical for
      // child→parent questions during a nested kickoff turn).
      const header = ack.message ?? `sent to ${ack.to ?? args.to}`;
      const summary =
        typeof (ack as { summary?: unknown }).summary === "string"
          ? (ack as { summary: string }).summary.trim()
          : "";
      if (!summary) return header;
      return (
        `${header}\n\n` +
        `--- reply from ${ack.to ?? args.to} ---\n` +
        summary
      );
    } catch (err) {
      return `agent_send failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);

server.tool(
  {
    name: "agent_wait",
    description:
      "Wait until a child is idle/done/failed/killed (or timeout). " +
      "Returns last result summary when available.",
    input: z.object({
      to: z
        .string()
        .min(1)
        .optional()
        .describe("Child slug or sessionKey (or use childSessionKey)"),
      childSessionKey: z.string().min(1).optional(),
      timeout_sec: z.number().optional().describe("Default 600"),
      poll_sec: z.number().optional().describe("Default 2"),
    }),
  },
  async (args) => {
    const env = requireSessionEnv();
    if (!env.ok) return `agent_wait failed: ${env.error}`;
    try {
      const ack = await workerAgentWait({
        sessionKey: env.sessionKey,
        ...(args.to ? { to: args.to } : {}),
        ...(args.childSessionKey
          ? { childSessionKey: args.childSessionKey }
          : {}),
        ...(args.timeout_sec != null
          ? { timeout_sec: args.timeout_sec }
          : {}),
        ...(args.poll_sec != null ? { poll_sec: args.poll_sec } : {}),
      });
      if (!ack.ok) return `agent_wait failed: ${ack.error}`;
      return (
        (ack.message ?? `status=${ack.status}`) +
        (ack.summary ? `\n${ack.summary}` : "")
      );
    } catch (err) {
      return `agent_wait failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);

server.tool(
  {
    name: "agent_kill",
    description:
      "Stop a child agent. dispose=false: soft-close (process stopped, session restorable). " +
      "dispose=true (default): drop from spawn registry. " +
      "remove_worktree=false (default): keep git worktree/branch on disk after hard kill; " +
      "set remove_worktree=true to delete the worktree.",
    input: z.object({
      to: z.string().min(1).optional().describe("Child slug or sessionKey"),
      childSessionKey: z.string().min(1).optional(),
      dispose: z
        .boolean()
        .optional()
        .describe(
          "true=hard remove from registry (default); false=soft-close keep restorable",
        ),
      remove_worktree: z
        .boolean()
        .optional()
        .describe(
          "Hard kill only. false/omit=keep worktree (default); true=delete worktree",
        ),
    }),
  },
  async (args) => {
    const env = requireSessionEnv();
    if (!env.ok) return `agent_kill failed: ${env.error}`;
    try {
      const ack = await workerAgentKill({
        sessionKey: env.sessionKey,
        ...(args.to ? { childSessionKey: args.to } : {}),
        ...(args.childSessionKey
          ? { childSessionKey: args.childSessionKey }
          : {}),
        ...(args.dispose != null ? { dispose: args.dispose } : {}),
        ...(args.remove_worktree != null
          ? { remove_worktree: args.remove_worktree }
          : {}),
      });
      if (!ack.ok) return `agent_kill failed: ${ack.error}`;
      return ack.message ?? "killed";
    } catch (err) {
      return `agent_kill failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);


await server.run();

