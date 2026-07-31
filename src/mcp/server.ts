/**
 * tacp MCP server (stdio) — tools the agent can call during a Telegram session.
 *
 * speak: enqueue TTS for the tacp daemon, which sendVoice to Telegram.
 * schedule_*: durable jobs under <repo>/.tacp/schedules/ (prompt + optional script).
 * The MCP process cannot call Telegram itself (it is a child of the agent).
 */
import { FastMCP } from "@prefecthq/fastmcp-ts/server";
import { z } from "zod";
import {
  cancelJob,
  createJob,
  listJobs,
} from "../schedules/store";
import {
  enqueueSpeakJob,
  speakQueueDir,
  waitForSpeakAck,
} from "./speak-queue";

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
    const queueDir = speakQueueDir();
    try {
      const job = await enqueueSpeakJob({
        sessionKey,
        text: cleaned,
        queueDir,
      });
      const ack = await waitForSpeakAck(job.id, {
        queueDir,
        timeoutMs: 90_000,
      });
      if (!ack.ok) {
        return `speak failed: ${ack.error}`;
      }
      return `Sent Telegram voice note (${cleaned.length} chars${
        ack.bytes != null ? `, ${ack.bytes} bytes` : ""
      }).`;
    } catch (err) {
      return `speak failed: ${err instanceof Error ? err.message : String(err)}`;
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
      "kind=once needs runAt (ISO); kind=cron needs cronExpr (5-field m h dom mon dow, UTC). " +
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
        .describe("IANA timezone stored on the job (MVP next-run uses UTC)"),
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
      return `Created schedule ${job.id}\n${JSON.stringify(job, null, 2)}`;
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
      "Soft-cancel a schedule by id: sets enabled=false (file and prompt remain).",
    input: z.object({
      id: z.string().min(1).describe("Schedule job id"),
    }),
  },
  async ({ id }) => {
    const env = requireSessionEnv();
    if (!env.ok) return `schedule_cancel failed: ${env.error}`;
    try {
      const job = await cancelJob(env.repoRoot, id);
      return `Cancelled schedule ${job.id} (enabled=false)\n${JSON.stringify(job, null, 2)}`;
    } catch (err) {
      return `schedule_cancel failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  },
);

await server.run();
