import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHotReloadableConfig,
  replaceReposMap,
  snapshotHotFields,
  watchConfigFile,
} from "../src/config-reload";
import type { AcpbotConfig } from "../src/env/types";

describe("applyHotReloadableConfig", () => {
  test("updates repos in place on shared map", () => {
    const repos: Record<string, string> = { demo: "/a" };
    const live: AcpbotConfig = {
      operatorUserId: 1,
      repos,
      defaultAgent: "grok-build",
    };
    const changed = applyHotReloadableConfig(live, {
      repos: { demo: "/a", spotify: "/b" },
      defaultAgent: "claude",
      permissionMode: "bypass",
    });
    expect(changed.sort()).toEqual(
      ["defaultAgent", "permissionMode", "repos"].sort(),
    );
    expect(live.repos).toBe(repos); // same object
    expect(repos).toEqual({ demo: "/a", spotify: "/b" });
    expect(live.defaultAgent).toBe("claude");
    expect(live.permissionMode).toBe("bypass");
  });

  test("no-op when unchanged", () => {
    const live: AcpbotConfig = {
      operatorUserId: 1,
      repos: { x: "/x" },
      defaultAgent: "grok-build",
    };
    const changed = applyHotReloadableConfig(live, {
      repos: { x: "/x" },
      defaultAgent: "grok-build",
    });
    expect(changed).toEqual([]);
  });
});

describe("replaceReposMap", () => {
  test("mutates target", () => {
    const t: Record<string, string> = { a: "/1" };
    expect(replaceReposMap(t, { b: "/2" })).toBe(true);
    expect(t).toEqual({ b: "/2" });
    expect(replaceReposMap(t, { b: "/2" })).toBe(false);
  });
});

describe("snapshotHotFields", () => {
  test("copies repos", () => {
    const s = snapshotHotFields({
      repos: { d: "/d" },
      defaultAgent: "codex",
    });
    expect(s.repos).toEqual({ d: "/d" });
    expect(s.defaultAgent).toBe("codex");
  });
});

describe("watchConfigFile", () => {
  test("reloads repos when file changes", async () => {
    const home = mkdtempSync(join(tmpdir(), "acpbot-reload-"));
    const cfgDir = join(home, ".config", "acpbot");
    mkdirSync(cfgDir, { recursive: true });
    const configPath = join(cfgDir, "config.toml");
    writeFileSync(
      configPath,
      `bot_token = "1:TESTTOKEN_ABCDEFGHIJKLMNOP"\ndefault_agent = "grok-build"\n\n[repos]\nold = "${home}/old"\n`,
      "utf8",
    );
    mkdirSync(join(home, "old"), { recursive: true });
    mkdirSync(join(home, "new"), { recursive: true });

    const live: AcpbotConfig = {
      operatorUserId: 0,
      repos: { old: join(home, "old") },
      defaultAgent: "grok-build",
    };
    const catalog: Record<string, string> = { old: join(home, "old") };
    live.repos = catalog;

    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    };

    let reloaded: string[] = [];
    const w = watchConfigFile({
      configPath,
      live,
      reposCatalog: catalog,
      debounceMs: 50,
      env,
      applyEnv: false,
      onReloaded: (c) => {
        reloaded = c;
      },
    });

    writeFileSync(
      configPath,
      `bot_token = "1:TESTTOKEN_ABCDEFGHIJKLMNOP"\ndefault_agent = "claude"\n\n[repos]\nnew = "${home}/new"\n`,
      "utf8",
    );

    // Wait for debounce + load
    for (let i = 0; i < 40; i++) {
      if (reloaded.includes("repos")) break;
      await Bun.sleep(50);
    }

    w.close();

    expect(reloaded).toContain("repos");
    expect(catalog).toEqual({ new: join(home, "new") });
    expect(live.defaultAgent).toBe("claude");
  });
});
