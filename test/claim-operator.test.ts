import { describe, expect, test } from "bun:test";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listPendingPairs } from "../src/core/pairing";

describe("claim operator (CLI pairing)", () => {
  test("first message does not auto-claim; issues pairing code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claim-"));
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
        from: { id: 99, first_name: "me" },
        chat: { id: 1000, type: "private" },
      },
    });
    // No auto-claim — must use acpbot pair approve <code>
    expect(env.config.operatorUserId).toBe(0);
    const pending = await listPendingPairs(state);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.userId).toBe(99);
    expect(
      env.telegram.sentMessages().some((m) => /pair approve/i.test(m.text ?? "")),
    ).toBe(true);
  });
});
