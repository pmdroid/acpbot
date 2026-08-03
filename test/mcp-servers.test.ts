import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
  buildAcpbotMcpServers,
  defaultAcpbotMcpServerEntry,
} from "../src/mcp/servers";
import {
  buildSessionMcpServers,
  expandHomeToken,
  filterRepoMcpByProfile,
  injectSessionEnv,
  isPathLikeToken,
  isStdioServer,
  isWithinRepo,
  loadRepoMcpProfiles,
  loadRepoMcpServers,
  loadRepoAcpbotConfig,
  resolveRepoPathToken,
  ACPBOT_BUILTIN_MCP_NAME,
} from "../src/mcp/repo-mcp";

describe("buildAcpbotMcpServers", () => {
  test("returns stdio acpbot server via mcp-server subcommand", () => {
    const servers = buildAcpbotMcpServers({ enabled: true });
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("acpbot");
    expect(servers[0]?.command).toBe(process.execPath);
    // bun path: [main.ts, "mcp-server"] · compiled: ["mcp-server"]
    expect(servers[0]?.args).toContain("mcp-server");
    expect(Array.isArray(servers[0]?.env)).toBe(true);
  });

  test("serverEntry override still uses script path", () => {
    const entry = defaultAcpbotMcpServerEntry();
    const servers = buildAcpbotMcpServers({
      enabled: true,
      serverEntry: entry,
    });
    expect(servers[0]?.args[0]).toBe(entry);
    expect(existsSync(servers[0]!.args[0]!)).toBe(true);
  });

  test("disabled returns empty", () => {
    expect(buildAcpbotMcpServers({ enabled: false })).toEqual([]);
  });

  test("injects sessionKey and worker API sock for outbound tools", () => {
    const servers = buildAcpbotMcpServers({
      enabled: true,
      sessionKey: "demo/topic",
      stateDir: "/tmp/acpbot-state",
    });
    const env = Object.fromEntries(
      (servers[0]?.env ?? []).map((e) => [e.name, e.value]),
    );
    expect(env.ACPBOT_SESSION_KEY).toBe("demo/topic");
    expect(env.ACPBOT_WORKER_API_SOCK).toBe("/tmp/acpbot-state/worker-api.sock");
    expect(env.ACPBOT_STATE_DIR).toBe("/tmp/acpbot-state");
  });
});

describe("path safety helpers", () => {
  test("isPathLikeToken: paths vs packages/flags/binaries", () => {
    expect(isPathLikeToken("bun")).toBe(false);
    expect(isPathLikeToken("npx")).toBe(false);
    expect(isPathLikeToken("-y")).toBe(false);
    expect(isPathLikeToken("--yes")).toBe(false);
    expect(isPathLikeToken("--package=@scope/pkg")).toBe(false);
    expect(isPathLikeToken("--config=.acpbot/cfg.json")).toBe(false);
    expect(isPathLikeToken("@modelcontextprotocol/server-github")).toBe(false);
    expect(isPathLikeToken("@scope/pkg")).toBe(false);
    expect(isPathLikeToken("https://example.com/mcp")).toBe(false);
    expect(isPathLikeToken("run")).toBe(false);

    expect(isPathLikeToken("./bin/tool")).toBe(true);
    expect(isPathLikeToken(".acpbot/tools/server.ts")).toBe(true);
    expect(isPathLikeToken("/usr/bin/node")).toBe(true);
    expect(isPathLikeToken("../escape")).toBe(true);
    expect(isPathLikeToken("~/bin/tool")).toBe(true);
    expect(isPathLikeToken("~")).toBe(true);
  });

  test("resolveRepoPathToken resolves relative under root", () => {
    const root = "/tmp/my-repo";
    expect(resolveRepoPathToken(root, ".acpbot/tools/server.ts")).toBe(
      resolve(root, ".acpbot/tools/server.ts"),
    );
    expect(resolveRepoPathToken(root, "./tools/x.ts")).toBe(
      resolve(root, "tools/x.ts"),
    );
    expect(resolveRepoPathToken(root, "bun")).toBe("bun");
  });

  test("resolveRepoPathToken leaves npm package specs and flags unchanged", () => {
    const root = "/tmp/my-repo";
    expect(
      resolveRepoPathToken(root, "@modelcontextprotocol/server-github"),
    ).toBe("@modelcontextprotocol/server-github");
    expect(resolveRepoPathToken(root, "-y")).toBe("-y");
    expect(resolveRepoPathToken(root, "--package=@scope/pkg")).toBe(
      "--package=@scope/pkg",
    );
    expect(resolveRepoPathToken(root, "https://mcp.example/x")).toBe(
      "https://mcp.example/x",
    );
  });

  test("resolveRepoPathToken allows absolute paths outside repo", () => {
    const root = "/tmp/my-repo";
    expect(resolveRepoPathToken(root, "/usr/bin/node")).toBe(
      resolve("/usr/bin/node"),
    );
  });

  test("resolveRepoPathToken expands ~ to home (absolute)", () => {
    const root = "/tmp/my-repo";
    expect(resolveRepoPathToken(root, "~/tools/x")).toBe(
      resolve(homedir(), "tools/x"),
    );
    expect(expandHomeToken("~")).toBe(homedir());
  });

  test("resolveRepoPathToken rejects .. escape outside repo", () => {
    const root = "/tmp/my-repo";
    expect(() => resolveRepoPathToken(root, "../outside")).toThrow(/escapes/);
    expect(() =>
      resolveRepoPathToken(root, ".acpbot/../../etc/passwd"),
    ).toThrow(/escapes/);
  });

  test("isWithinRepo", () => {
    expect(isWithinRepo("/repo", "/repo")).toBe(true);
    expect(isWithinRepo("/repo", "/repo/sub")).toBe(true);
    expect(isWithinRepo("/repo", "/repo-other")).toBe(false);
    expect(isWithinRepo("/repo", "/etc")).toBe(false);
  });

  test("isStdioServer treats type stdio and absent type as stdio", () => {
    expect(
      isStdioServer({
        name: "a",
        command: "bun",
        args: [],
        env: [],
      }),
    ).toBe(true);
    expect(
      isStdioServer({
        name: "a",
        command: "bun",
        args: [],
        env: [],
        // runtime-only shape; not on SessionMcpServer type
        ...({ type: "stdio" } as object),
      } as Parameters<typeof isStdioServer>[0]),
    ).toBe(true);
    expect(
      isStdioServer({
        type: "http",
        name: "r",
        url: "https://x",
        headers: [],
      }),
    ).toBe(false);
  });
});

describe("loadRepoMcpServers / buildSessionMcpServers", () => {
  async function withRepo(
    setup: (repo: string) => Promise<void>,
    run: (repo: string) => Promise<void>,
  ) {
    const repo = await mkdtemp(join(tmpdir(), "acpbot-mcp-repo-"));
    try {
      await setup(repo);
      await run(repo);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }

  test("missing mcp.json → empty repo list", async () => {
    await withRepo(
      async () => {},
      async (repo) => {
        const servers = await loadRepoMcpServers(repo);
        expect(servers).toEqual([]);
      },
    );
  });

  test("missing file → buildSessionMcpServers is built-in only", async () => {
    await withRepo(
      async () => {},
      async (repo) => {
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "demo/main",
          stateDir: "/tmp/host-state",
        });
        expect(servers).toHaveLength(1);
        expect(servers[0]?.name).toBe("acpbot");
      },
    );
  });

  test("invalid JSON → warn path, built-in only", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".acpbot"), { recursive: true });
        await writeFile(join(repo, ".acpbot", "mcp.json"), "{not json", "utf8");
      },
      async (repo) => {
        const repoOnly = await loadRepoMcpServers(repo);
        expect(repoOnly).toEqual([]);
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "x/y",
        });
        expect(servers.map((s) => s.name)).toEqual(["acpbot"]);
      },
    );
  });

  test("merge order: repo first, then built-in acpbot", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".acpbot", "tools"), { recursive: true });
        await writeFile(
          join(repo, ".acpbot", "mcp.json"),
          JSON.stringify({
            mcpServers: [
              {
                name: "local-tools",
                command: "bun",
                args: ["run", ".acpbot/tools/server.ts"],
                env: { FOO: "bar" },
              },
            ],
          }),
          "utf8",
        );
      },
      async (repo) => {
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "demo/topic",
          stateDir: "/tmp/host-state",
        });
        expect(servers.map((s) => s.name)).toEqual(["local-tools", "acpbot"]);
        const local = servers[0] as {
          name: string;
          command: string;
          args: string[];
          env: Array<{ name: string; value: string }>;
        };
        expect(local.command).toBe("bun");
        expect(local.args).toEqual([
          "run",
          resolve(repo, ".acpbot/tools/server.ts"),
        ]);
      },
    );
  });

  test("npx -y @scope/package args are not rewritten", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".acpbot"), { recursive: true });
        await writeFile(
          join(repo, ".acpbot", "mcp.json"),
          JSON.stringify({
            mcpServers: [
              {
                name: "github",
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-github"],
              },
            ],
          }),
          "utf8",
        );
      },
      async (repo) => {
        const repoServers = await loadRepoMcpServers(repo);
        expect(repoServers).toHaveLength(1);
        const s = repoServers[0] as {
          command: string;
          args: string[];
        };
        expect(s.command).toBe("npx");
        expect(s.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);

        const merged = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "demo/main",
        });
        const github = merged.find((x) => x.name === "github") as {
          args: string[];
        };
        expect(github.args).toEqual([
          "-y",
          "@modelcontextprotocol/server-github",
        ]);
      },
    );
  });

  test("absolute command/args allowed outside repo", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".acpbot"), { recursive: true });
        await writeFile(
          join(repo, ".acpbot", "mcp.json"),
          JSON.stringify({
            mcpServers: [
              {
                name: "sys",
                command: "/usr/bin/env",
                args: ["node", "/opt/tools/mcp-server.js"],
              },
            ],
          }),
          "utf8",
        );
      },
      async (repo) => {
        const repoServers = await loadRepoMcpServers(repo);
        expect(repoServers).toHaveLength(1);
        const s = repoServers[0] as { command: string; args: string[] };
        expect(s.command).toBe(resolve("/usr/bin/env"));
        expect(s.args).toEqual([
          "node",
          resolve("/opt/tools/mcp-server.js"),
        ]);
      },
    );
  });

  test("path safety rejects .. escape in args", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".acpbot"), { recursive: true });
        await writeFile(
          join(repo, ".acpbot", "mcp.json"),
          JSON.stringify({
            mcpServers: [
              {
                name: "evil",
                command: "bun",
                args: ["run", "../../etc/passwd"],
              },
              {
                name: "ok",
                command: "bun",
                args: ["run", ".acpbot/ok.ts"],
              },
            ],
          }),
          "utf8",
        );
      },
      async (repo) => {
        const repoServers = await loadRepoMcpServers(repo);
        expect(repoServers.map((s) => s.name)).toEqual(["ok"]);
      },
    );
  });

  test("skips reserved name acpbot and duplicate names", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".acpbot"), { recursive: true });
        await writeFile(
          join(repo, ".acpbot", "mcp.json"),
          JSON.stringify({
            mcpServers: [
              {
                name: ACPBOT_BUILTIN_MCP_NAME,
                command: "bun",
                args: ["run", ".acpbot/evil.ts"],
              },
              {
                name: "dup",
                command: "bun",
                args: ["run", ".acpbot/a.ts"],
              },
              {
                name: "dup",
                command: "bun",
                args: ["run", ".acpbot/b.ts"],
              },
              {
                name: "keep",
                command: "bun",
                args: ["run", ".acpbot/c.ts"],
              },
            ],
          }),
          "utf8",
        );
      },
      async (repo) => {
        const repoServers = await loadRepoMcpServers(repo);
        expect(repoServers.map((s) => s.name)).toEqual(["dup", "keep"]);
        const merged = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "x/y",
        });
        // only one built-in acpbot; reserved repo entry skipped
        expect(merged.filter((s) => s.name === "acpbot")).toHaveLength(1);
        expect(merged.map((s) => s.name)).toEqual(["dup", "keep", "acpbot"]);
      },
    );
  });

  test("env injection: session key, repo root, state dir", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".acpbot"), { recursive: true });
        await writeFile(
          join(repo, ".acpbot", "mcp.json"),
          JSON.stringify({
            mcpServers: [
              {
                name: "local-tools",
                command: "bun",
                args: ["run", ".acpbot/tools/server.ts"],
                env: { FOO: "bar" },
              },
            ],
          }),
          "utf8",
        );
      },
      async (repo) => {
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "life/main",
          stateDir: "/tmp/host-state",
        });
        expect(servers).toHaveLength(2);

        for (const s of servers) {
          if (!("env" in s) || !s.env) continue;
          const env = Object.fromEntries(s.env.map((e) => [e.name, e.value]));
          expect(env.ACPBOT_SESSION_KEY).toBe("life/main");
          expect(env.ACPBOT_REPO_ROOT).toBe(resolve(repo));
          expect(env.ACPBOT_REPO_STATE_DIR).toBe(resolve(repo, ".acpbot"));
        }

        const local = servers[0] as {
          env: Array<{ name: string; value: string }>;
        };
        const localEnv = Object.fromEntries(
          local.env.map((e) => [e.name, e.value]),
        );
        expect(localEnv.FOO).toBe("bar");

        const builtin = servers[1] as {
          env: Array<{ name: string; value: string }>;
        };
        const builtinEnv = Object.fromEntries(
          builtin.env.map((e) => [e.name, e.value]),
        );
        expect(builtinEnv.ACPBOT_WORKER_API_SOCK).toBe(
          "/tmp/host-state/worker-api.sock",
        );
        expect(builtinEnv.ACPBOT_STATE_DIR).toBe("/tmp/host-state");
      },
    );
  });

  test("injectSessionEnv applies when type is explicitly stdio", () => {
    const withType = {
      name: "x",
      command: "bun",
      args: [] as string[],
      env: [] as Array<{ name: string; value: string }>,
      type: "stdio" as const,
    };
    // Runtime objects may carry type: "stdio"; guard must still inject.
    const out = injectSessionEnv(
      withType as unknown as Parameters<typeof injectSessionEnv>[0],
      {
        sessionKey: "a/b",
        repoRoot: "/repo",
        repoStateDir: "/repo/.acpbot",
      },
    );
    expect(isStdioServer(out) || ("env" in out && Array.isArray(out.env))).toBe(
      true,
    );
    const env = Object.fromEntries(
      (out as { env: Array<{ name: string; value: string }> }).env.map((e) => [
        e.name,
        e.value,
      ]),
    );
    expect(env.ACPBOT_SESSION_KEY).toBe("a/b");
    expect(env.ACPBOT_REPO_ROOT).toBe(resolve("/repo"));
  });

  test("http/sse remotes become stdio mcp-proxy by default", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".acpbot"), { recursive: true });
        await writeFile(
          join(repo, ".acpbot", "mcp.json"),
          JSON.stringify({
            mcpServers: [
              {
                name: "linear",
                type: "http",
                url: "https://mcp.example/linear",
              },
            ],
          }),
          "utf8",
        );
      },
      async (repo) => {
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "demo/main",
          repoKey: "demo",
          // Public remote without OAuth — do not fail-closed.
          oauthFailClosed: false,
        });
        const linear = servers[0] as {
          name: string;
          command: string;
          args: string[];
          env: Array<{ name: string; value: string }>;
        };
        expect(linear.name).toBe("linear");
        expect(linear.args).toContain("mcp-proxy");
        const env = Object.fromEntries(linear.env.map((e) => [e.name, e.value]));
        expect(env.ACPBOT_MCP_PROXY_URL).toBe("https://mcp.example/linear");
        expect(env.ACPBOT_MCP_PROXY_ID).toBe("linear");
        expect(env.ACPBOT_SESSION_KEY).toBe("demo/main");
        expect(servers[1]?.name).toBe("acpbot");
      },
    );
  });


  test("disabled returns empty", async () => {
    const servers = await buildSessionMcpServers({
      cwd: process.cwd(),
      enabled: false,
    });
    expect(servers).toEqual([]);
  });
});

describe("repo acpbot config + mcp profiles", () => {
  async function withRepo(
    setup: (repo: string) => Promise<void>,
    run: (repo: string) => Promise<void>,
  ) {
    const repo = await mkdtemp(join(tmpdir(), "acpbot-mcp-profile-"));
    try {
      await setup(repo);
      await run(repo);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }

  async function writeMcpServers(
    repo: string,
    names: string[],
  ): Promise<void> {
    await mkdir(join(repo, ".acpbot"), { recursive: true });
    await writeFile(
      join(repo, ".acpbot", "mcp.json"),
      JSON.stringify({
        mcpServers: names.map((name) => ({
          name,
          command: "bun",
          args: ["run", `.acpbot/${name}.ts`],
        })),
      }),
      "utf8",
    );
  }

  test("loadRepoAcpbotConfig missing file → empty", async () => {
    await withRepo(
      async () => {},
      async (repo) => {
        expect(await loadRepoAcpbotConfig(repo)).toEqual({});
      },
    );
  });

  test("loadRepoAcpbotConfig parses defaultAgent and mcpProfile", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".acpbot"), { recursive: true });
        await writeFile(
          join(repo, ".acpbot", "config.json"),
          JSON.stringify({
            defaultAgent: "grok-build",
            mcpProfile: "automation",
            extra: "ignored",
          }),
          "utf8",
        );
      },
      async (repo) => {
        expect(await loadRepoAcpbotConfig(repo)).toEqual({
          defaultAgent: "grok-build",
          mcpProfile: "automation",
        });
      },
    );
  });

  test("loadRepoMcpProfiles missing file → undefined", async () => {
    await withRepo(
      async () => {},
      async (repo) => {
        expect(await loadRepoMcpProfiles(repo)).toBeUndefined();
      },
    );
  });

  test("loadRepoMcpProfiles parses allowlists", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".acpbot"), { recursive: true });
        await writeFile(
          join(repo, ".acpbot", "mcp.profiles.json"),
          JSON.stringify({
            automation: ["schedule", "homeassistant"],
            coding: [],
          }),
          "utf8",
        );
      },
      async (repo) => {
        expect(await loadRepoMcpProfiles(repo)).toEqual({
          automation: ["schedule", "homeassistant"],
          coding: [],
        });
      },
    );
  });

  test("filterRepoMcpByProfile: no profile / missing map → all servers", () => {
    const servers = [
      { name: "a", command: "bun", args: [], env: [] },
      { name: "b", command: "bun", args: [], env: [] },
    ];
    expect(filterRepoMcpByProfile(servers, undefined, { a: ["a"] })).toEqual(
      servers,
    );
    expect(filterRepoMcpByProfile(servers, "x", undefined)).toEqual(servers);
  });

  test("filterRepoMcpByProfile: unknown profile name → no filter", () => {
    const servers = [
      { name: "schedule", command: "bun", args: [], env: [] },
      { name: "homeassistant", command: "bun", args: [], env: [] },
    ];
    expect(
      filterRepoMcpByProfile(servers, "missing", {
        automation: ["schedule"],
      }),
    ).toEqual(servers);
  });

  test("filterRepoMcpByProfile: empty list → no repo MCP", () => {
    const servers = [
      { name: "schedule", command: "bun", args: [], env: [] },
    ];
    expect(
      filterRepoMcpByProfile(servers, "coding", { coding: [] }),
    ).toEqual([]);
  });

  test("filterRepoMcpByProfile: allowlist keeps matching names only", () => {
    const servers = [
      { name: "schedule", command: "bun", args: [], env: [] },
      { name: "homeassistant", command: "bun", args: [], env: [] },
      { name: "other", command: "bun", args: [], env: [] },
    ];
    expect(
      filterRepoMcpByProfile(servers, "automation", {
        automation: ["schedule", "homeassistant", "not-in-mcp"],
      }).map((s) => s.name),
    ).toEqual(["schedule", "homeassistant"]);
  });

  test("buildSessionMcpServers applies profile from config.json", async () => {
    await withRepo(
      async (repo) => {
        await writeMcpServers(repo, [
          "schedule",
          "homeassistant",
          "devtools",
        ]);
        await writeFile(
          join(repo, ".acpbot", "config.json"),
          JSON.stringify({ mcpProfile: "automation" }),
          "utf8",
        );
        await writeFile(
          join(repo, ".acpbot", "mcp.profiles.json"),
          JSON.stringify({
            automation: ["schedule", "homeassistant"],
            coding: [],
          }),
          "utf8",
        );
      },
      async (repo) => {
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "life/main",
        });
        expect(servers.map((s) => s.name)).toEqual([
          "schedule",
          "homeassistant",
          "acpbot",
        ]);
      },
    );
  });

  test("empty profile → built-in acpbot only", async () => {
    await withRepo(
      async (repo) => {
        await writeMcpServers(repo, ["schedule", "devtools"]);
        await writeFile(
          join(repo, ".acpbot", "config.json"),
          JSON.stringify({ mcpProfile: "coding" }),
          "utf8",
        );
        await writeFile(
          join(repo, ".acpbot", "mcp.profiles.json"),
          JSON.stringify({ coding: [] }),
          "utf8",
        );
      },
      async (repo) => {
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "code/feat",
        });
        expect(servers.map((s) => s.name)).toEqual(["acpbot"]);
      },
    );
  });

  test("missing profiles file → no filter (all repo MCP)", async () => {
    await withRepo(
      async (repo) => {
        await writeMcpServers(repo, ["schedule", "devtools"]);
        await writeFile(
          join(repo, ".acpbot", "config.json"),
          JSON.stringify({ mcpProfile: "automation" }),
          "utf8",
        );
      },
      async (repo) => {
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "life/main",
        });
        expect(servers.map((s) => s.name)).toEqual([
          "schedule",
          "devtools",
          "acpbot",
        ]);
      },
    );
  });

  test("unknown profile name → no filter (all repo MCP)", async () => {
    await withRepo(
      async (repo) => {
        await writeMcpServers(repo, ["schedule", "devtools"]);
        await writeFile(
          join(repo, ".acpbot", "config.json"),
          JSON.stringify({ mcpProfile: "does-not-exist" }),
          "utf8",
        );
        await writeFile(
          join(repo, ".acpbot", "mcp.profiles.json"),
          JSON.stringify({ automation: ["schedule"] }),
          "utf8",
        );
      },
      async (repo) => {
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "life/main",
        });
        expect(servers.map((s) => s.name)).toEqual([
          "schedule",
          "devtools",
          "acpbot",
        ]);
      },
    );
  });

  test("mcpProfile option overrides config.json", async () => {
    await withRepo(
      async (repo) => {
        await writeMcpServers(repo, ["schedule", "devtools"]);
        await writeFile(
          join(repo, ".acpbot", "config.json"),
          JSON.stringify({ mcpProfile: "automation" }),
          "utf8",
        );
        await writeFile(
          join(repo, ".acpbot", "mcp.profiles.json"),
          JSON.stringify({
            automation: ["schedule"],
            coding: ["devtools"],
          }),
          "utf8",
        );
      },
      async (repo) => {
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "code/feat",
          mcpProfile: "coding",
        });
        expect(servers.map((s) => s.name)).toEqual(["devtools", "acpbot"]);
      },
    );
  });

  test("missing config.json → no filter", async () => {
    await withRepo(
      async (repo) => {
        await writeMcpServers(repo, ["schedule", "devtools"]);
        await writeFile(
          join(repo, ".acpbot", "mcp.profiles.json"),
          JSON.stringify({ automation: ["schedule"] }),
          "utf8",
        );
      },
      async (repo) => {
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "life/main",
        });
        expect(servers.map((s) => s.name)).toEqual([
          "schedule",
          "devtools",
          "acpbot",
        ]);
      },
    );
  });

  test("invalid JSON config.json → empty config (no filter)", async () => {
    await withRepo(
      async (repo) => {
        await writeMcpServers(repo, ["schedule", "devtools"]);
        await writeFile(join(repo, ".acpbot", "config.json"), "{not json", "utf8");
        await writeFile(
          join(repo, ".acpbot", "mcp.profiles.json"),
          JSON.stringify({ automation: ["schedule"] }),
          "utf8",
        );
      },
      async (repo) => {
        expect(await loadRepoAcpbotConfig(repo)).toEqual({});
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "life/main",
        });
        expect(servers.map((s) => s.name)).toEqual([
          "schedule",
          "devtools",
          "acpbot",
        ]);
      },
    );
  });

  test("invalid JSON mcp.profiles.json → undefined → no filter", async () => {
    await withRepo(
      async (repo) => {
        await writeMcpServers(repo, ["schedule", "devtools"]);
        await writeFile(
          join(repo, ".acpbot", "config.json"),
          JSON.stringify({ mcpProfile: "automation" }),
          "utf8",
        );
        await writeFile(
          join(repo, ".acpbot", "mcp.profiles.json"),
          "{not json",
          "utf8",
        );
      },
      async (repo) => {
        expect(await loadRepoMcpProfiles(repo)).toBeUndefined();
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "life/main",
        });
        expect(servers.map((s) => s.name)).toEqual([
          "schedule",
          "devtools",
          "acpbot",
        ]);
      },
    );
  });

  test("allowlist with no matching servers → empty repo MCP + acpbot", async () => {
    await withRepo(
      async (repo) => {
        await writeMcpServers(repo, ["schedule", "devtools"]);
        await writeFile(
          join(repo, ".acpbot", "config.json"),
          JSON.stringify({ mcpProfile: "automation" }),
          "utf8",
        );
        await writeFile(
          join(repo, ".acpbot", "mcp.profiles.json"),
          JSON.stringify({ automation: ["not-present", "also-missing"] }),
          "utf8",
        );
      },
      async (repo) => {
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "life/main",
        });
        expect(servers.map((s) => s.name)).toEqual(["acpbot"]);
      },
    );
  });

  test("loadRepoMcpProfiles trims profile keys", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".acpbot"), { recursive: true });
        // raw JSON so the key retains surrounding whitespace
        await writeFile(
          join(repo, ".acpbot", "mcp.profiles.json"),
          '{ " automation ": ["schedule"] }',
          "utf8",
        );
      },
      async (repo) => {
        const profiles = await loadRepoMcpProfiles(repo);
        expect(profiles).toEqual({ automation: ["schedule"] });
      },
    );
  });

  test("non-array profile value skipped; remaining keys still load", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".acpbot"), { recursive: true });
        await writeFile(
          join(repo, ".acpbot", "mcp.profiles.json"),
          JSON.stringify({
            broken: "not-an-array",
            automation: ["schedule"],
          }),
          "utf8",
        );
      },
      async (repo) => {
        expect(await loadRepoMcpProfiles(repo)).toEqual({
          automation: ["schedule"],
        });
      },
    );
  });

  test("unknown mcpProfile warns with available keys (fail-open)", () => {
    const warns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const log = {
      level: "warn" as const,
      debug() {},
      info() {},
      warn(msg: string, meta?: Record<string, unknown>) {
        warns.push({ msg, meta });
      },
      error() {},
      child() {
        return log;
      },
    };
    const servers = [
      { name: "schedule", command: "bun", args: [], env: [] },
    ];
    const out = filterRepoMcpByProfile(
      servers,
      "typo-profile",
      { automation: ["schedule"] },
      log,
    );
    expect(out).toEqual(servers);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toMatch(/unknown mcpProfile/);
    expect(warns[0]!.meta?.profileName).toBe("typo-profile");
    expect(warns[0]!.meta?.available).toEqual(["automation"]);
  });

  test("mcpProfile set but profiles missing warns (fail-open)", () => {
    const warns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const log = {
      level: "warn" as const,
      debug() {},
      info() {},
      warn(msg: string, meta?: Record<string, unknown>) {
        warns.push({ msg, meta });
      },
      error() {},
      child() {
        return log;
      },
    };
    const servers = [
      { name: "schedule", command: "bun", args: [], env: [] },
    ];
    const out = filterRepoMcpByProfile(servers, "automation", undefined, log);
    expect(out).toEqual(servers);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toMatch(/profiles unavailable/);
    expect(warns[0]!.meta?.profileName).toBe("automation");
  });
});
