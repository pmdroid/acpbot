import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
  buildTacpMcpServers,
  defaultTacpMcpServerEntry,
} from "../src/mcp/servers";
import {
  buildSessionMcpServers,
  expandHomeToken,
  injectSessionEnv,
  isPathLikeToken,
  isStdioServer,
  isWithinRepo,
  loadRepoMcpServers,
  resolveRepoPathToken,
  TACP_BUILTIN_MCP_NAME,
} from "../src/mcp/repo-mcp";

describe("buildTacpMcpServers", () => {
  test("returns stdio tacp server with bun entry", () => {
    const servers = buildTacpMcpServers({ enabled: true });
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("tacp");
    expect(servers[0]?.command).toBe(process.execPath);
    expect(servers[0]?.args[0]).toBe(defaultTacpMcpServerEntry());
    expect(existsSync(servers[0]!.args[0]!)).toBe(true);
    expect(Array.isArray(servers[0]?.env)).toBe(true);
  });

  test("disabled returns empty", () => {
    expect(buildTacpMcpServers({ enabled: false })).toEqual([]);
  });

  test("injects sessionKey and queue dir env for speak", () => {
    const servers = buildTacpMcpServers({
      enabled: true,
      sessionKey: "demo/topic",
      stateDir: "/tmp/tacp-state",
    });
    const env = Object.fromEntries(
      (servers[0]?.env ?? []).map((e) => [e.name, e.value]),
    );
    expect(env.TACP_SESSION_KEY).toBe("demo/topic");
    expect(env.TACP_SPEAK_QUEUE_DIR).toBe("/tmp/tacp-state");
  });
});

describe("path safety helpers", () => {
  test("isPathLikeToken: paths vs packages/flags/binaries", () => {
    expect(isPathLikeToken("bun")).toBe(false);
    expect(isPathLikeToken("npx")).toBe(false);
    expect(isPathLikeToken("-y")).toBe(false);
    expect(isPathLikeToken("--yes")).toBe(false);
    expect(isPathLikeToken("--package=@scope/pkg")).toBe(false);
    expect(isPathLikeToken("--config=.tacp/cfg.json")).toBe(false);
    expect(isPathLikeToken("@modelcontextprotocol/server-github")).toBe(false);
    expect(isPathLikeToken("@scope/pkg")).toBe(false);
    expect(isPathLikeToken("https://example.com/mcp")).toBe(false);
    expect(isPathLikeToken("run")).toBe(false);

    expect(isPathLikeToken("./bin/tool")).toBe(true);
    expect(isPathLikeToken(".tacp/tools/server.ts")).toBe(true);
    expect(isPathLikeToken("/usr/bin/node")).toBe(true);
    expect(isPathLikeToken("../escape")).toBe(true);
    expect(isPathLikeToken("~/bin/tool")).toBe(true);
    expect(isPathLikeToken("~")).toBe(true);
  });

  test("resolveRepoPathToken resolves relative under root", () => {
    const root = "/tmp/my-repo";
    expect(resolveRepoPathToken(root, ".tacp/tools/server.ts")).toBe(
      resolve(root, ".tacp/tools/server.ts"),
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
      resolveRepoPathToken(root, ".tacp/../../etc/passwd"),
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
    const repo = await mkdtemp(join(tmpdir(), "tacp-mcp-repo-"));
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
        expect(servers[0]?.name).toBe("tacp");
      },
    );
  });

  test("invalid JSON → warn path, built-in only", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".tacp"), { recursive: true });
        await writeFile(join(repo, ".tacp", "mcp.json"), "{not json", "utf8");
      },
      async (repo) => {
        const repoOnly = await loadRepoMcpServers(repo);
        expect(repoOnly).toEqual([]);
        const servers = await buildSessionMcpServers({
          cwd: repo,
          enabled: true,
          sessionKey: "x/y",
        });
        expect(servers.map((s) => s.name)).toEqual(["tacp"]);
      },
    );
  });

  test("merge order: repo first, then built-in tacp", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".tacp", "tools"), { recursive: true });
        await writeFile(
          join(repo, ".tacp", "mcp.json"),
          JSON.stringify({
            mcpServers: [
              {
                name: "local-tools",
                command: "bun",
                args: ["run", ".tacp/tools/server.ts"],
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
        expect(servers.map((s) => s.name)).toEqual(["local-tools", "tacp"]);
        const local = servers[0] as {
          name: string;
          command: string;
          args: string[];
          env: Array<{ name: string; value: string }>;
        };
        expect(local.command).toBe("bun");
        expect(local.args).toEqual([
          "run",
          resolve(repo, ".tacp/tools/server.ts"),
        ]);
      },
    );
  });

  test("npx -y @scope/package args are not rewritten", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".tacp"), { recursive: true });
        await writeFile(
          join(repo, ".tacp", "mcp.json"),
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
        await mkdir(join(repo, ".tacp"), { recursive: true });
        await writeFile(
          join(repo, ".tacp", "mcp.json"),
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
        await mkdir(join(repo, ".tacp"), { recursive: true });
        await writeFile(
          join(repo, ".tacp", "mcp.json"),
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
                args: ["run", ".tacp/ok.ts"],
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

  test("skips reserved name tacp and duplicate names", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".tacp"), { recursive: true });
        await writeFile(
          join(repo, ".tacp", "mcp.json"),
          JSON.stringify({
            mcpServers: [
              {
                name: TACP_BUILTIN_MCP_NAME,
                command: "bun",
                args: ["run", ".tacp/evil.ts"],
              },
              {
                name: "dup",
                command: "bun",
                args: ["run", ".tacp/a.ts"],
              },
              {
                name: "dup",
                command: "bun",
                args: ["run", ".tacp/b.ts"],
              },
              {
                name: "keep",
                command: "bun",
                args: ["run", ".tacp/c.ts"],
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
        // only one built-in tacp; reserved repo entry skipped
        expect(merged.filter((s) => s.name === "tacp")).toHaveLength(1);
        expect(merged.map((s) => s.name)).toEqual(["dup", "keep", "tacp"]);
      },
    );
  });

  test("env injection: session key, repo root, state dir", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".tacp"), { recursive: true });
        await writeFile(
          join(repo, ".tacp", "mcp.json"),
          JSON.stringify({
            mcpServers: [
              {
                name: "local-tools",
                command: "bun",
                args: ["run", ".tacp/tools/server.ts"],
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
          expect(env.TACP_SESSION_KEY).toBe("life/main");
          expect(env.TACP_REPO_ROOT).toBe(resolve(repo));
          expect(env.TACP_STATE_DIR).toBe(resolve(repo, ".tacp"));
        }

        const local = servers[0] as {
          env: Array<{ name: string; value: string }>;
        };
        const localEnv = Object.fromEntries(
          local.env.map((e) => [e.name, e.value]),
        );
        expect(localEnv.FOO).toBe("bar");

        const tacp = servers[1] as {
          env: Array<{ name: string; value: string }>;
        };
        const tacpEnv = Object.fromEntries(
          tacp.env.map((e) => [e.name, e.value]),
        );
        expect(tacpEnv.TACP_SPEAK_QUEUE_DIR).toBe("/tmp/host-state");
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
        repoStateDir: "/repo/.tacp",
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
    expect(env.TACP_SESSION_KEY).toBe("a/b");
    expect(env.TACP_REPO_ROOT).toBe(resolve("/repo"));
  });

  test("http/sse remote entries are passed through", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".tacp"), { recursive: true });
        await writeFile(
          join(repo, ".tacp", "mcp.json"),
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
        });
        expect(servers[0]).toMatchObject({
          type: "http",
          name: "linear",
          url: "https://mcp.example/linear",
          headers: [],
        });
        expect(servers[1]?.name).toBe("tacp");
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
