import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
  buildTacpMcpServers,
  defaultTacpMcpServerEntry,
} from "../src/mcp/servers";
import {
  buildSessionMcpServers,
  isPathLikeToken,
  isWithinRepo,
  loadRepoMcpServers,
  resolveRepoPathToken,
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
  test("isPathLikeToken", () => {
    expect(isPathLikeToken("bun")).toBe(false);
    expect(isPathLikeToken("npx")).toBe(false);
    expect(isPathLikeToken("./bin/tool")).toBe(true);
    expect(isPathLikeToken(".tacp/tools/server.ts")).toBe(true);
    expect(isPathLikeToken("/usr/bin/node")).toBe(true);
    expect(isPathLikeToken("../escape")).toBe(true);
  });

  test("resolveRepoPathToken resolves relative under root", () => {
    const root = "/tmp/my-repo";
    expect(resolveRepoPathToken(root, ".tacp/tools/server.ts")).toBe(
      resolve(root, ".tacp/tools/server.ts"),
    );
    expect(resolveRepoPathToken(root, "bun")).toBe("bun");
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
          if (!("env" in s)) continue;
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
