/**
 * IPC for MCP telegram tools → tacp daemon → sendMessage / sendPhoto / sendDocument.
 *
 * The MCP server is a child of the agent and cannot call Telegram.
 * It enqueues a job; the daemon delivers to the session topic and acks.
 */
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type TelegramJobKind = "update" | "message" | "document" | "photo";

export type TelegramJobRequest = {
  id: string;
  sessionKey: string;
  kind: TelegramJobKind;
  /** Text body (update/message) or optional caption (photo/document). */
  text: string;
  /** Absolute path on the host for photo/document jobs (daemon reads bytes). */
  path?: string;
  /** Filename override for Telegram (document). */
  filename?: string;
  /** Optional MIME hint for logging / content-type. */
  contentType?: string;
  createdAt: string;
};

export type TelegramJobAck =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string };

export function telegramQueueDir(
  stateDir = process.env.TACP_SPEAK_QUEUE_DIR?.trim() ||
    process.env.TACP_ACPX_STATE_DIR?.trim() ||
    "./data/acpx-state",
): string {
  return join(stateDir.replace(/\/$/, ""), "telegram-queue");
}

function paths(dir: string, id: string) {
  return {
    req: join(dir, `${id}.req.json`),
    tmp: join(dir, `${id}.req.tmp`),
    done: join(dir, `${id}.done.json`),
    err: join(dir, `${id}.err.json`),
  };
}

function normalizeKind(raw: unknown): TelegramJobKind {
  if (raw === "update") return "update";
  if (raw === "photo") return "photo";
  if (raw === "document") return "document";
  return "message";
}

export async function enqueueTelegramJob(input: {
  sessionKey: string;
  text?: string;
  kind?: TelegramJobKind;
  path?: string;
  filename?: string;
  contentType?: string;
  queueDir?: string;
}): Promise<TelegramJobRequest> {
  const dir = input.queueDir ?? telegramQueueDir();
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const kind = input.kind ?? "message";
  const job: TelegramJobRequest = {
    id,
    sessionKey: input.sessionKey.trim(),
    text: (input.text ?? "").trim(),
    kind,
    createdAt: new Date().toISOString(),
  };
  if (input.path?.trim()) job.path = input.path.trim();
  if (input.filename?.trim()) job.filename = input.filename.trim();
  if (input.contentType?.trim()) job.contentType = input.contentType.trim();

  if (
    (kind === "photo" || kind === "document") &&
    !job.path
  ) {
    throw new Error(`telegram ${kind} job requires path`);
  }
  if ((kind === "update" || kind === "message") && !job.text) {
    throw new Error(`telegram ${kind} job requires text`);
  }

  const p = paths(dir, id);
  await writeFile(p.tmp, `${JSON.stringify(job)}\n`, "utf8");
  await rename(p.tmp, p.req);
  return job;
}

export async function waitForTelegramAck(
  id: string,
  opts?: { queueDir?: string; timeoutMs?: number; pollMs?: number },
): Promise<TelegramJobAck> {
  const dir = opts?.queueDir ?? telegramQueueDir();
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const pollMs = opts?.pollMs ?? 80;
  const p = paths(dir, id);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = await readFile(p.done, "utf8");
      const ack = JSON.parse(raw) as TelegramJobAck;
      await unlink(p.done).catch(() => {});
      return ack;
    } catch {
      /* not done */
    }
    try {
      const raw = await readFile(p.err, "utf8");
      const ack = JSON.parse(raw) as TelegramJobAck;
      await unlink(p.err).catch(() => {});
      return ack;
    } catch {
      /* not err */
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { id, ok: false, error: `telegram job timed out after ${timeoutMs}ms` };
}

export async function listPendingTelegramJobs(
  queueDir?: string,
): Promise<TelegramJobRequest[]> {
  const dir = queueDir ?? telegramQueueDir();
  await mkdir(dir, { recursive: true });
  const names = await readdir(dir);
  const out: TelegramJobRequest[] = [];
  for (const name of names) {
    if (!name.endsWith(".req.json")) continue;
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const job = JSON.parse(raw) as TelegramJobRequest;
      if (!job?.id || !job.sessionKey) continue;
      const kind = normalizeKind(job.kind);
      if ((kind === "photo" || kind === "document") && !job.path) continue;
      if ((kind === "update" || kind === "message") && !job.text) continue;
      out.push({
        id: job.id,
        sessionKey: job.sessionKey,
        kind,
        text: typeof job.text === "string" ? job.text : "",
        createdAt:
          typeof job.createdAt === "string"
            ? job.createdAt
            : new Date(0).toISOString(),
        ...(job.path ? { path: job.path } : {}),
        ...(job.filename ? { filename: job.filename } : {}),
        ...(job.contentType ? { contentType: job.contentType } : {}),
      });
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

export async function completeTelegramJob(
  job: TelegramJobRequest,
  result: { ok: true } | { ok: false; error: string },
  queueDir?: string,
): Promise<void> {
  const dir = queueDir ?? telegramQueueDir();
  const p = paths(dir, job.id);
  const ack: TelegramJobAck =
    result.ok === true
      ? { id: job.id, ok: true }
      : { id: job.id, ok: false, error: result.error };
  const target = result.ok ? p.done : p.err;
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ack)}\n`, "utf8");
  await rename(tmp, target);
  await unlink(p.req).catch(() => {});
}
