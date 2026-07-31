/**
 * IPC for MCP speak → tacp daemon → Telegram sendVoice.
 *
 * The MCP server is a child of the agent process and cannot call Telegram.
 * It enqueues a speak job; the daemon synthesizes TTS and sendVoice, then
 * writes a done/error ack the MCP tool awaits.
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type SpeakJobRequest = {
  id: string;
  sessionKey: string;
  text: string;
  createdAt: string;
};

export type SpeakJobAck =
  | { id: string; ok: true; bytes?: number }
  | { id: string; ok: false; error: string };

export function speakQueueDir(
  stateDir = process.env.TACP_SPEAK_QUEUE_DIR?.trim() ||
    process.env.TACP_ACPX_STATE_DIR?.trim() ||
    "./data/acpx-state",
): string {
  return join(stateDir.replace(/\/$/, ""), "speak-queue");
}

function paths(dir: string, id: string) {
  return {
    req: join(dir, `${id}.req.json`),
    tmp: join(dir, `${id}.req.tmp`),
    done: join(dir, `${id}.done.json`),
    err: join(dir, `${id}.err.json`),
  };
}

export async function enqueueSpeakJob(input: {
  sessionKey: string;
  text: string;
  queueDir?: string;
}): Promise<SpeakJobRequest> {
  const dir = input.queueDir ?? speakQueueDir();
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const job: SpeakJobRequest = {
    id,
    sessionKey: input.sessionKey.trim(),
    text: input.text.trim(),
    createdAt: new Date().toISOString(),
  };
  const p = paths(dir, id);
  await writeFile(p.tmp, `${JSON.stringify(job)}\n`, "utf8");
  await rename(p.tmp, p.req);
  return job;
}

export async function waitForSpeakAck(
  id: string,
  opts?: { queueDir?: string; timeoutMs?: number; pollMs?: number },
): Promise<SpeakJobAck> {
  const dir = opts?.queueDir ?? speakQueueDir();
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const pollMs = opts?.pollMs ?? 100;
  const p = paths(dir, id);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = await readFile(p.done, "utf8");
      const ack = JSON.parse(raw) as SpeakJobAck;
      await unlink(p.done).catch(() => {});
      return ack;
    } catch {
      /* not done */
    }
    try {
      const raw = await readFile(p.err, "utf8");
      const ack = JSON.parse(raw) as SpeakJobAck;
      await unlink(p.err).catch(() => {});
      return ack;
    } catch {
      /* not err */
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { id, ok: false, error: `speak timed out after ${timeoutMs}ms` };
}

export async function listPendingSpeakJobs(
  queueDir?: string,
): Promise<SpeakJobRequest[]> {
  const dir = queueDir ?? speakQueueDir();
  await mkdir(dir, { recursive: true });
  const names = await readdir(dir);
  const out: SpeakJobRequest[] = [];
  for (const name of names) {
    if (!name.endsWith(".req.json")) continue;
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const job = JSON.parse(raw) as SpeakJobRequest;
      if (job?.id && job.sessionKey && job.text) out.push(job);
    } catch {
      /* skip corrupt */
    }
  }
  // oldest first
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

export async function completeSpeakJob(
  job: SpeakJobRequest,
  result: { ok: true; bytes?: number } | { ok: false; error: string },
  queueDir?: string,
): Promise<void> {
  const dir = queueDir ?? speakQueueDir();
  const p = paths(dir, job.id);
  const ack: SpeakJobAck =
    result.ok === true
      ? { id: job.id, ok: true, bytes: result.bytes }
      : { id: job.id, ok: false, error: result.error };
  const target = result.ok ? p.done : p.err;
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ack)}\n`, "utf8");
  await rename(tmp, target);
  await unlink(p.req).catch(() => {});
}
