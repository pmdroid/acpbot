import { describe, expect, test } from "bun:test";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("claim operator", () => {
  test("first message claims when operatorUserId is 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claim-"));
    const cfgPath = join(dir, "config.toml");
    writeFileSync(cfgPath, 'bot_token = "x"\noperator_user_id = 0\n');
    const env = createFakeEnvironment({
      config: { operatorUserId: 0, repos: { demo: "/tmp/d" } },
    });
    const d = createDaemon(env, { configPath: cfgPath });
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
    expect(env.config.operatorUserId).toBe(99);
    expect(readFileSync(cfgPath, "utf8")).toMatch(/operator_user_id = 99/);
    expect(env.telegram.sentMessages().some((m) => /operator/i.test(m.text ?? ""))).toBe(true);
  });
});
