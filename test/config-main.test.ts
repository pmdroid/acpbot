import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";

describe("loadConfig (shipped entry config)", () => {
  test("requires bot token, operator id, store path, acpx state dir", () => {
    expect(() => loadConfig({ env: {} })).toThrow(/bot token/i);
    expect(() =>
      loadConfig({ env: { TACP_BOT_TOKEN: "t" } }),
    ).toThrow(/operator/i);
    expect(() =>
      loadConfig({
        env: { TACP_BOT_TOKEN: "t", TACP_OPERATOR_USER_ID: "1" },
      }),
    ).toThrow(/store path/i);
    expect(() =>
      loadConfig({
        env: {
          TACP_BOT_TOKEN: "t",
          TACP_OPERATOR_USER_ID: "1",
          TACP_STORE_PATH: "/tmp/x.json",
        },
      }),
    ).toThrow(/acpx state/i);
  });

  test("loads complete config without assuming host layout", () => {
    const cfg = loadConfig({
      env: {
        TACP_BOT_TOKEN: "tok-abc",
        TACP_OPERATOR_USER_ID: "42",
        TACP_STORE_PATH: "/cfg/store.json",
        TACP_ACPX_STATE_DIR: "/cfg/acpx",
        TACP_REPOS_JSON: JSON.stringify({ tacp: "/cfg/repos/tacp" }),
        TACP_AGENT_BACKEND: "echo",
        TACP_DEFAULT_AGENT: "codex",
      },
    });
    expect(cfg.botToken).toBe("tok-abc");
    expect(cfg.operatorUserId).toBe(42);
    expect(cfg.storePath).toBe("/cfg/store.json");
    expect(cfg.acpxStateDir).toBe("/cfg/acpx");
    expect(cfg.repos?.tacp).toBe("/cfg/repos/tacp");
    expect(cfg.agentBackend).toBe("echo");
    expect(cfg.defaultAgent).toBe("codex");
  });

  test("agentBackend real is default when unset", () => {
    const cfg = loadConfig({
      env: {
        TACP_BOT_TOKEN: "t",
        TACP_OPERATOR_USER_ID: "9",
        TACP_STORE_PATH: "/s",
        TACP_ACPX_STATE_DIR: "/a",
      },
    });
    expect(cfg.agentBackend).toBe("real");
  });
});

describe("main entry wiring (structural + import)", () => {
  test("main.ts wires telegram, agents, store, clock from config", () => {
    const mainPath = join(import.meta.dir, "../src/main.ts");
    const src = readFileSync(mainPath, "utf8");
    expect(src).toContain("loadConfig");
    expect(src).toContain("realTelegram");
    expect(src).toContain("realAgents");
    expect(src).toContain("echoAgents");
    expect(src).toContain("createJsonFileStore");
    expect(src).toContain("systemClock");
    expect(src).toContain("createDaemon");
    expect(src).toContain("agentBackend");
    // No hardcoded bot tokens or home paths.
    expect(src).not.toMatch(/[0-9]{8,}:[A-Za-z0-9_-]{20,}/);
    expect(src).not.toMatch(/\/Users\//);
    expect(src).not.toMatch(/process\.env\.HOME/);
  });

  test("main entry fails clearly when required env is missing", async () => {
    const env = { ...process.env };
    for (const k of [
      "TACP_BOT_TOKEN",
      "TACP_OPERATOR_USER_ID",
      "TACP_STORE_PATH",
      "TACP_ACPX_STATE_DIR",
      "BOT_TOKEN",
      "OPERATOR_USER_ID",
    ]) {
      delete env[k];
    }
    // Bun auto-loads cwd .env — point at an empty env-file so the real
    // missing-config path is exercised, not a live poll with project secrets.
    const emptyEnv = join(import.meta.dir, "fixtures/empty.env");
    const proc = Bun.spawn(
      ["bun", `--env-file=${emptyEnv}`, "run", "src/main.ts"],
      {
        cwd: join(import.meta.dir, ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).not.toBe(0);
    const out = `${stdout}\n${stderr}`;
    expect(out).toMatch(/Missing bot token|TACP_BOT_TOKEN/i);
    // Module resolution must succeed (not "Cannot find module").
    expect(out).not.toMatch(/Cannot find module/i);
  });
});
