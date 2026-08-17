import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  applyConfigToEnv,
  defaultConfigPath,
  defaultStateDir,
  defaultStorePath,
  loadConfig,
  normalizeToml,
  parseTomlConfig,
} from "../src/config";

describe("loadConfig (TOML + defaults)", () => {
  test("requires bot token for worker role (operator optional / claim later)", () => {
    expect(() =>
      loadConfig({ env: { HOME: "/tmp/acpbot-home-test" }, skipFile: true }),
    ).toThrow(/bot_token|bot token/i);
    const cfg = loadConfig({
      env: {
        HOME: "/tmp/acpbot-home-test",
        ACPBOT_BOT_TOKEN: "999:not-a-placeholder-token-xxxx",
      },
      skipFile: true,
    });
    expect(cfg.botToken).toContain("999:");
    expect(cfg.operatorUserId).toBe(0);
  });

  test("defaults store + state under XDG data home", () => {
    const home = "/tmp/acpbot-xdg-home";
    const cfg = loadConfig({
      env: {
        HOME: home,
        ACPBOT_BOT_TOKEN: "tok",
        ACPBOT_OPERATOR_USER_ID: "7",
      },
      skipFile: true,
    });
    expect(cfg.storePath).toBe(join(home, ".local/share/acpbot/store.json"));
    expect(cfg.stateDir).toBe(join(home, ".local/share/acpbot/state"));
    expect(cfg.defaultAgent).toBe("grok-build");
    expect(cfg.mcpEnabled).toBe(true);
    expect(cfg.ttsMode).toBe("agent");
  });

  test("loads complete config from TOML file", () => {
    const dir = mkdtempSync(join(tmpdir(), "acpbot-cfg-"));
    const path = join(dir, "config.toml");
    writeFileSync(
      path,
      `
bot_token = "tok-toml"
store_path = "${dir}/store.json"
state_dir = "${dir}/state"
default_agent = "codex"
log_level = "warn"

[repos]
demo = "${dir}/repo"

[features]
mcp = false
tts_mode = "off"

[oauth]
callback_base = "https://ex.ts.net"
listen_port = 9999

[schedule]
tick_ms = 15000
`,
      "utf8",
    );

    const cfg = loadConfig({
      configPath: path,
      env: { HOME: dir },
    });
    expect(cfg.botToken).toBe("tok-toml");
    expect(cfg.operatorUserId).toBe(0); // operator is pairing state, not TOML
    expect(cfg.storePath).toBe(join(dir, "store.json"));
    expect(cfg.stateDir).toBe(join(dir, "state"));
    expect(cfg.repos?.demo).toBe(join(dir, "repo"));
    expect(cfg.defaultAgent).toBe("codex");
    expect(cfg.logLevel).toBe("warn");
    expect(cfg.mcpEnabled).toBe(false);
    expect(cfg.ttsMode).toBe("off");
    expect(cfg.oauthCallbackBase).toBe("https://ex.ts.net:8788");
    expect(cfg.oauthListenPort).toBe(9999);
    expect(cfg.scheduleTickMs).toBe(15000);
    expect(cfg.configPath).toBe(path);
  });

  test("env overrides work without TOML", () => {
    const cfg = loadConfig({
      env: {
        HOME: "/tmp/x",
        ACPBOT_BOT_TOKEN: "tok-abc",
        ACPBOT_STORE_PATH: "/cfg/store.json",
        ACPBOT_STATE_DIR: "/cfg/state",
        ACPBOT_REPOS_JSON: JSON.stringify({ acpbot: "/cfg/repos/acpbot" }),
        ACPBOT_DEFAULT_AGENT: "codex",
      },
      skipFile: true,
    });
    expect(cfg.botToken).toBe("tok-abc");
    expect(cfg.operatorUserId).toBe(0);
    expect(cfg.storePath).toBe("/cfg/store.json");
    expect(cfg.stateDir).toBe("/cfg/state");
    expect(cfg.repos?.acpbot).toBe("/cfg/repos/acpbot");
    expect(cfg.defaultAgent).toBe("codex");
  });

  test("[computer] parses and ACPBOT_COMPUTER=0 forces off", () => {
    const on = loadConfig({
      skipFile: true,
      requireTelegram: false,
      file: {
        computer: {
          enabled: true,
          display: "browser",
          publish_frames: "on_action",
          jpeg_quality: 70,
          max_edge_px: 800,
          browser_headless: false,
        },
      },
    });
    expect(on.computer?.enabled).toBe(true);
    expect(on.computer?.display).toBe("browser");
    expect(on.computer?.publishFrames).toBe("on_action");
    expect(on.computer?.jpegQuality).toBe(70);
    expect(on.computer?.maxEdgePx).toBe(800);
    expect(on.computer?.browserHeadless).toBe(false);

    const off = loadConfig({
      skipFile: true,
      requireTelegram: false,
      env: { HOME: "/tmp/x", ACPBOT_COMPUTER: "0" },
      file: { computer: { enabled: true } },
    });
    expect(off.computer?.enabled).toBe(false);

    const missing = loadConfig({
      skipFile: true,
      requireTelegram: false,
      env: { HOME: "/tmp/x" },
    });
    expect(missing.computer?.enabled).toBeFalsy();
  });

  test("host role does not require bot token", () => {
    const cfg = loadConfig({
      requireTelegram: false,
      env: { HOME: "/tmp/host-home" },
      skipFile: true,
    });
    expect(cfg.stateDir).toContain("acpbot");
    expect(cfg.botToken).toBe("");
  });

  test("applyConfigToEnv publishes state + repos", () => {
    const env: Record<string, string | undefined> = {};
    const cfg = loadConfig({
      env: {
        HOME: "/tmp/apply",
        ACPBOT_BOT_TOKEN: "t",
        ACPBOT_REPOS_JSON: JSON.stringify({ d: "/tmp/d" }),
      },
      skipFile: true,
    });
    applyConfigToEnv(cfg, env as NodeJS.ProcessEnv);
    expect(env.ACPBOT_STATE_DIR).toBe(cfg.stateDir);
    expect(JSON.parse(env.ACPBOT_REPOS_JSON!)).toEqual({ d: "/tmp/d" });
  });

  test("normalizeToml accepts snake_case tables", () => {
    const n = normalizeToml(
      parseTomlConfig(`
bot_token = "x"
[features]
mcp = true
[repos]
a = "/b"
`),
    );
    expect(n.botToken).toBe("x");
    expect(n.mcpEnabled).toBe(true);
    expect(n.repos?.a).toBe("/b");
  });

  test("default paths helpers", () => {
    const env = { HOME: "/h" };
    expect(defaultConfigPath(env)).toBe("/h/.config/acpbot/config.toml");
    expect(defaultStorePath(env)).toBe("/h/.local/share/acpbot/store.json");
    expect(defaultStateDir(env)).toBe("/h/.local/share/acpbot/state");
  });
});

describe("main entry wiring (structural + import)", () => {
  test("unified CLI routes host/worker; worker wires real stack", () => {
    const mainPath = join(import.meta.dir, "../src/main.ts");
    const workerPath = join(import.meta.dir, "../src/worker-run.ts");
    const hostPath = join(import.meta.dir, "../src/host-run.ts");
    const mainSrc = readFileSync(mainPath, "utf8");
    const workerSrc = readFileSync(workerPath, "utf8");
    const hostSrc = readFileSync(hostPath, "utf8");

    // Router (bare acpbot → help; host/worker subcommands)
    expect(mainSrc).toContain("runWorkerMain");
    expect(mainSrc).toContain("runHostMain");
    expect(mainSrc).toContain("acpbotCliHelp");
    expect(mainSrc).not.toContain("echoAgents");
    expect(mainSrc).not.toMatch(/[0-9]{8,}:[A-Za-z0-9_-]{20,}/);
    expect(mainSrc).not.toMatch(/\/Users\//);

    // Worker process still wires the real stack
    expect(workerSrc).toContain("loadConfigWithSetup");
    expect(workerSrc).toContain("applyConfigToEnv");
    expect(workerSrc).toContain("realTelegram");
    expect(workerSrc).toContain("realAgents");
    expect(workerSrc).toContain("createJsonFileStore");
    expect(workerSrc).toContain("systemClock");
    expect(workerSrc).toContain("createDaemon");
    expect(workerSrc).not.toContain("echoAgents");

    expect(hostSrc).toContain("startAcpHostServer");
  });

  test("bare main prints help; worker fails clearly when config missing", async () => {
    const env = { ...process.env };
    for (const k of [
      "ACPBOT_BOT_TOKEN",
      "ACPBOT_OPERATOR_USER_ID",
      "ACPBOT_STORE_PATH",
      "ACPBOT_STATE_DIR",
      "ACPBOT_CONFIG",
      "BOT_TOKEN",
      "OPERATOR_USER_ID",
    ]) {
      delete env[k];
    }
    // Isolated HOME so we don't pick up the developer's real config.toml
    const home = mkdtempSync(join(tmpdir(), "acpbot-empty-home-"));
    env.HOME = home;
    env.XDG_CONFIG_HOME = join(home, ".config");
    env.XDG_DATA_HOME = join(home, ".local", "share");

    const emptyEnv = join(import.meta.dir, "fixtures/empty.env");
    const root = join(import.meta.dir, "..");

    // Bare CLI → help (exit 0)
    const helpProc = Bun.spawn(
      ["bun", `--env-file=${emptyEnv}`, "run", "src/main.ts"],
      {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      },
    );
    const [helpOut, helpErr, helpCode] = await Promise.all([
      new Response(helpProc.stdout).text(),
      new Response(helpProc.stderr).text(),
      helpProc.exited,
    ]);
    expect(helpCode).toBe(0);
    expect(`${helpOut}\n${helpErr}`).toMatch(/acpbot host|acpbot worker/i);

    // Worker without bot token → clear setup error (non-TTY)
    const proc = Bun.spawn(
      ["bun", `--env-file=${emptyEnv}`, "run", "src/main.ts", "worker"],
      {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).not.toBe(0);
    const out = `${stdout}\n${stderr}`;
    expect(out).toMatch(
      /bot_token|operator|Config needs setup|first-run|Missing|setup|REPLACE_ME/i,
    );
    expect(out).not.toMatch(/Cannot find module/i);
  });
});
