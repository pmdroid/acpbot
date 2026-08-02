import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, chmodSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configNeedsTelegramSetup,
  ensureAcpbotLayout,
  isPlaceholderBotToken,
  loadConfigWithSetup,
  renderConfigToml,
  runFirstRunSetup,
} from "../src/config-setup";
import { loadConfig } from "../src/config";

describe("first-run layout + setup", () => {
  test("isPlaceholderBotToken", () => {
    expect(isPlaceholderBotToken(undefined)).toBe(true);
    expect(isPlaceholderBotToken("")).toBe(true);
    expect(isPlaceholderBotToken("REPLACE_ME")).toBe(true);
    expect(isPlaceholderBotToken("123456:REPLACE_ME")).toBe(true);
    expect(isPlaceholderBotToken("7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")).toBe(
      false,
    );
  });

  test("ensureAcpbotLayout creates dirs and default config", () => {
    const home = mkdtempSync(join(tmpdir(), "acpbot-layout-"));
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    };
    const layout = ensureAcpbotLayout({ env });
    expect(layout.createdConfig).toBe(true);
    expect(existsSync(layout.configPath)).toBe(true);
    expect(existsSync(layout.stateDir)).toBe(true);
    expect(existsSync(layout.dataDir)).toBe(true);
    const body = readFileSync(layout.configPath, "utf8");
    expect(body).toContain("REPLACE_ME");
    // second call is idempotent
    const again = ensureAcpbotLayout({ env });
    expect(again.createdConfig).toBe(false);
  });

  test("runFirstRunSetup with answers writes usable config", async () => {
    const home = mkdtempSync(join(tmpdir(), "acpbot-setup-"));
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    };
    const layout = ensureAcpbotLayout({ env });
    const cfg = await runFirstRunSetup({
      configPath: layout.configPath,
      env,
      answers: {
        botToken: "999:TESTTOKEN_ABCDEFGHIJKLMNOPQRSTUV",
        operatorUserId: 42,
        defaultAgent: "codex",
        repoKey: "demo",
        repoPath: join(home, "code", "demo"),
      },
    });
    expect(cfg.botToken).toContain("TESTTOKEN");
    expect(cfg.operatorUserId).toBe(42);
    expect(cfg.defaultAgent).toBe("codex");
    expect(cfg.repos?.demo).toBe(join(home, "code", "demo"));
    expect(configNeedsTelegramSetup(cfg)).toBe(false);
  });

  test("operator_user_id 0 is allowed (claim later); only bot token required", async () => {
    const home = mkdtempSync(join(tmpdir(), "acpbot-claim-"));
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    };
    const layout = ensureAcpbotLayout({ env });
    const cfg = await runFirstRunSetup({
      configPath: layout.configPath,
      env,
      answers: {
        botToken: "999:TESTTOKEN_CLAIM_MODE_ABCDEFGHIJ",
        operatorUserId: 0,
        defaultAgent: "grok-build",
      },
    });
    expect(configNeedsTelegramSetup(cfg)).toBe(false);
    expect(cfg.operatorUserId).toBe(0);
    const { patchConfigOperatorUserId } = await import("../src/config-setup");
    patchConfigOperatorUserId(layout.configPath, 77);
    const again = loadConfig({ configPath: layout.configPath, env });
    expect(again.operatorUserId).toBe(77);
  });

  test("loadConfigWithSetup non-interactive throws after creating default", async () => {
    const home = mkdtempSync(join(tmpdir(), "acpbot-noint-"));
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    };
    await expect(
      loadConfigWithSetup({
        env,
        requireTelegram: true,
        interactive: false,
      }),
    ).rejects.toThrow(/Config needs setup|bot_token|operator/i);
    expect(existsSync(join(home, ".config", "acpbot", "config.toml"))).toBe(
      true,
    );
  });

  test("renderConfigToml escapes quotes", () => {
    const toml = renderConfigToml({
      botToken: 'x"y',
      operatorUserId: 1,
      defaultAgent: "grok-build",
    });
    expect(toml).toContain('bot_token = "x\\"y"');
    const cfg = loadConfig({
      skipFile: true,
      file: {
        bot_token: 'x"y',
        operator_user_id: 1,
      },
      env: { HOME: "/tmp" },
    });
    // file path uses normalizeToml via options.file as Record - bot_token snake
    expect(cfg.operatorUserId).toBe(1);
  });
});
