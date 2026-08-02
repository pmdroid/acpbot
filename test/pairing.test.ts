import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDaemon } from "../src/core/daemon";
import {
  approvePairingCode,
  formatPairingCodeDisplay,
  generatePairingCode,
  issuePairingCode,
  listPendingPairs,
  normalizePairingCode,
  takeAppliedPairing,
} from "../src/core/pairing";
import { createFakeEnvironment } from "../src/env/fake-env";
import { loadPairedOperator } from "../src/core/pairing";

describe("pairing codes", () => {
  test("normalize strips separators", () => {
    expect(normalizePairingCode("ab-cd 12")).toBe("ABCD12");
    expect(formatPairingCodeDisplay("ABCD1234")).toBe("ABCD-1234");
  });

  test("generatePairingCode is uppercase alphanumeric", () => {
    const c = generatePairingCode(8);
    expect(normalizePairingCode(c).length).toBe(8);
  });

  test("issue + approve + take applied", async () => {
    const state = mkdtempSync(join(tmpdir(), "pair-state-"));
    const pending = await issuePairingCode(state, {
      userId: 42,
      chatId: 100,
      username: "alice",
    });
    expect(pending.userId).toBe(42);
    const list = await listPendingPairs(state);
    expect(list).toHaveLength(1);
    expect(list[0]!.code).toBe(pending.code);

    // same user reuses code
    const again = await issuePairingCode(state, {
      userId: 42,
      chatId: 100,
    });
    expect(normalizePairingCode(again.code)).toBe(
      normalizePairingCode(pending.code),
    );

    const approved = await approvePairingCode(state, pending.code);
    expect(approved.userId).toBe(42);
    expect(await listPendingPairs(state)).toHaveLength(0);

    const applied = await takeAppliedPairing(state);
    expect(applied?.userId).toBe(42);
    // second take is no-op (consumed)
    expect(await takeAppliedPairing(state)).toBeUndefined();
  });

  test("approve unknown code throws", async () => {
    const state = mkdtempSync(join(tmpdir(), "pair-miss-"));
    await expect(approvePairingCode(state, "ZZZZ-ZZZZ")).rejects.toThrow(
      /No pending/,
    );
  });
});

describe("daemon CLI pairing", () => {
  test("unclaimed DM issues code; does not claim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pair-d-"));
    const state = join(dir, "state");
    const cfgPath = join(dir, "config.toml");
    writeFileSync(cfgPath, 'bot_token = "x"\n');
    const env = createFakeEnvironment({
      config: { operatorUserId: 0, repos: { demo: "/tmp/d" } },
    });
    const d = createDaemon(env, { configPath: cfgPath, stateDir: state });
    await d.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        text: "/ping",
        from: { id: 99, first_name: "me", username: "me" },
        chat: { id: 1000, type: "private" },
      },
    });
    expect(env.config.operatorUserId).toBe(0);
    const pending = await listPendingPairs(state);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.userId).toBe(99);
    const texts = env.telegram.sentMessages().map((m) => m.text ?? "");
    expect(texts.some((t) => /pair approve/i.test(t))).toBe(true);
    expect(texts.some((t) => t.includes(pending[0]!.code))).toBe(true);
  });

  test("CLI approve then poll applies operator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pair-app-"));
    const state = join(dir, "state");
    const cfgPath = join(dir, "config.toml");
    writeFileSync(cfgPath, 'bot_token = "x"\n');
    const env = createFakeEnvironment({
      config: { operatorUserId: 0, repos: { demo: "/tmp/d" } },
    });
    const d = createDaemon(env, { configPath: cfgPath, stateDir: state });

    await d.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        text: "hi",
        from: { id: 77, first_name: "op" },
        chat: { id: 2000, type: "private" },
      },
    });
    const pending = await listPendingPairs(state);
    expect(pending[0]!.userId).toBe(77);

    await approvePairingCode(state, pending[0]!.code);
    const stored = await loadPairedOperator(state);
    expect(stored?.userId).toBe(77);

    // Next update path applies CLI approval
    await d.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 1,
        text: "/ping",
        from: { id: 77, first_name: "op" },
        chat: { id: 2000, type: "private" },
      },
    });
    expect(env.config.operatorUserId).toBe(77);
    // now operator — /ping should get pong (after claim notify)
    const texts = env.telegram.sentMessages().map((m) => m.text ?? "");
    expect(texts.some((t) => /approved|operator/i.test(t))).toBe(true);
  });
});
