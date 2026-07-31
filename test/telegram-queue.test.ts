import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  completeTelegramJob,
  enqueueTelegramJob,
  listPendingTelegramJobs,
  telegramQueueDir,
  waitForTelegramAck,
} from "../src/mcp/telegram-queue";
import {
  isTelegramMessageToolName,
  isTelegramTextToolName,
  isTelegramUpdateToolName,
  telegramTextFromToolInput,
} from "../src/core/telegram-tools";

describe("telegram-queue", () => {
  test("enqueue + list + complete ack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-q-"));
    const queueDir = telegramQueueDir(dir);
    const job = await enqueueTelegramJob({
      sessionKey: "demo/a",
      text: "halfway done",
      kind: "update",
      queueDir,
    });
    const pending = await listPendingTelegramJobs(queueDir);
    expect(pending.some((j) => j.id === job.id)).toBe(true);
    expect(pending.find((j) => j.id === job.id)?.kind).toBe("update");

    const wait = waitForTelegramAck(job.id, { queueDir, timeoutMs: 2000 });
    await completeTelegramJob(job, { ok: true }, queueDir);
    const ack = await wait;
    expect(ack.ok).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("telegram tool name detection", () => {
  test("matches update / telegram_send prefixes", () => {
    expect(isTelegramUpdateToolName("update")).toBe(true);
    expect(isTelegramUpdateToolName("mcp__tacp__update")).toBe(true);
    expect(isTelegramUpdateToolName("tacp:update")).toBe(true);
    expect(isTelegramUpdateToolName("progress")).toBe(true);
    expect(isTelegramMessageToolName("telegram_send")).toBe(true);
    expect(isTelegramMessageToolName("mcp__tacp__telegram_send")).toBe(true);
    expect(isTelegramTextToolName("speak")).toBe(false);
    expect(telegramTextFromToolInput({ text: " hi " })).toBe("hi");
  });
});
