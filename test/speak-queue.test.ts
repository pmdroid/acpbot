import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  completeSpeakJob,
  enqueueSpeakJob,
  listPendingSpeakJobs,
  waitForSpeakAck,
  speakQueueDir,
} from "../src/mcp/speak-queue";

describe("speak-queue", () => {
  test("enqueue + list + complete ack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "speak-q-"));
    const stateDir = dir;
    const queueDir = speakQueueDir(stateDir);
    const job = await enqueueSpeakJob({
      sessionKey: "demo/a",
      text: "hello voice",
      queueDir,
    });
    const pending = await listPendingSpeakJobs(queueDir);
    expect(pending.some((j) => j.id === job.id)).toBe(true);

    const wait = waitForSpeakAck(job.id, { queueDir, timeoutMs: 2000 });
    await completeSpeakJob(job, { ok: true, bytes: 12 }, queueDir);
    const ack = await wait;
    expect(ack.ok).toBe(true);
    if (ack.ok) expect(ack.bytes).toBe(12);

    await rm(dir, { recursive: true, force: true });
  });
});
