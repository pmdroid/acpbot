import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatMcpRegistryStatus,
  MCP_COMMAND_USAGE,
  readMcpConfig,
  removeMcpServer,
  writeRemoteMcpServer,
} from "../src/mcp/repo-mcp";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { TelegramUpdate } from "../src/env/types";
import {
  COMMANDS,
  commandAllowedIn,
  parseSlashCommand,
  topicHelpText,
} from "../src/core/commands";

async function withRepo(
  setup: (repo: string) => Promise<void>,
  run: (repo: string) => Promise<void>,
) {
  const repo = await mkdtemp(join(tmpdir(), "tacp-mcp-reg-"));
  try {
    await setup(repo);
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

describe("writeRemoteMcpServer / removeMcpServer", () => {
  test("add writes only id + url + type (http default)", async () => {
    await withRepo(
      async () => {},
      async (repo) => {
        const entry = await writeRemoteMcpServer(repo, {
          name: "linear",
          url: "https://mcp.example/linear",
        });
        expect(entry).toEqual({
          name: "linear",
          type: "http",
          url: "https://mcp.example/linear",
        });

        const raw = await readFile(join(repo, ".tacp", "mcp.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          mcpServers: Array<Record<string, unknown>>;
        };
        expect(parsed.mcpServers).toHaveLength(1);
        const s = parsed.mcpServers[0]!;
        expect(Object.keys(s).sort()).toEqual(["name", "type", "url"]);
        expect(s).toEqual({
          name: "linear",
          type: "http",
          url: "https://mcp.example/linear",
        });
        expect(s).not.toHaveProperty("headers");
        expect(s).not.toHaveProperty("env");
        expect(s).not.toHaveProperty("token");
        expect(s).not.toHaveProperty("authorization");
        expect(s).not.toHaveProperty("oauth");
      },
    );
  });

  test("add replaces existing same id without preserving secrets", async () => {
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
                url: "https://old.example",
                headers: [{ name: "Authorization", value: "Bearer SECRET" }],
                token: "leak-me",
              },
            ],
          }),
          "utf8",
        );
      },
      async (repo) => {
        await writeRemoteMcpServer(repo, {
          name: "linear",
          url: "https://mcp.example/linear",
        });
        const config = await readMcpConfig(repo);
        expect(config.mcpServers).toHaveLength(1);
        const s = config.mcpServers[0]!;
        expect(Object.keys(s).sort()).toEqual(["name", "type", "url"]);
        expect(JSON.stringify(s)).not.toContain("SECRET");
        expect(JSON.stringify(s)).not.toContain("leak");
        expect(JSON.stringify(s)).not.toContain("headers");
      },
    );
  });

  test("add preserves other stdio entries", async () => {
    await withRepo(
      async (repo) => {
        await mkdir(join(repo, ".tacp"), { recursive: true });
        await writeFile(
          join(repo, ".tacp", "mcp.json"),
          JSON.stringify({
            mcpServers: [
              {
                name: "local",
                command: "bun",
                args: ["run", ".tacp/tools/x.ts"],
                env: { FOO: "bar" },
              },
            ],
          }),
          "utf8",
        );
      },
      async (repo) => {
        await writeRemoteMcpServer(repo, {
          name: "linear",
          url: "https://mcp.example/linear",
          type: "sse",
        });
        const config = await readMcpConfig(repo);
        expect(config.mcpServers.map((s) => s.name)).toEqual([
          "local",
          "linear",
        ]);
        expect(config.mcpServers[0]).toMatchObject({
          name: "local",
          command: "bun",
          env: { FOO: "bar" },
        });
        expect(config.mcpServers[1]).toEqual({
          name: "linear",
          type: "sse",
          url: "https://mcp.example/linear",
        });
      },
    );
  });

  test("remove works", async () => {
    await withRepo(
      async () => {},
      async (repo) => {
        await writeRemoteMcpServer(repo, {
          name: "a",
          url: "https://a.example",
        });
        await writeRemoteMcpServer(repo, {
          name: "b",
          url: "https://b.example",
        });
        expect(await removeMcpServer(repo, "a")).toBe(true);
        expect(await removeMcpServer(repo, "a")).toBe(false);
        const config = await readMcpConfig(repo);
        expect(config.mcpServers.map((s) => s.name)).toEqual(["b"]);
      },
    );
  });

  test("invalid name / url throw clear errors", async () => {
    await withRepo(
      async () => {},
      async (repo) => {
        await expect(
          writeRemoteMcpServer(repo, { name: "", url: "https://x" }),
        ).rejects.toThrow(/id is required/i);
        await expect(
          writeRemoteMcpServer(repo, {
            name: "tacp",
            url: "https://x.example",
          }),
        ).rejects.toThrow(/reserved/i);
        await expect(
          writeRemoteMcpServer(repo, {
            name: "bad name",
            url: "https://x.example",
          }),
        ).rejects.toThrow(/invalid MCP id/i);
        await expect(
          writeRemoteMcpServer(repo, { name: "ok", url: "not-a-url" }),
        ).rejects.toThrow(/invalid MCP url/i);
        await expect(
          writeRemoteMcpServer(repo, { name: "ok", url: "ftp://x" }),
        ).rejects.toThrow(/http\(s\)/i);
      },
    );
  });

  test("format status and usage helpers", () => {
    expect(formatMcpRegistryStatus({ mcpServers: [] })).toContain(
      "/mcp add",
    );
    expect(
      formatMcpRegistryStatus({
        mcpServers: [
          { name: "linear", type: "http", url: "https://mcp.example/linear" },
        ],
      }),
    ).toContain("linear");
    expect(MCP_COMMAND_USAGE).toContain("/mcp add");
  });
});

describe("/mcp slash command wiring", () => {
  const OPERATOR = 42;
  const CHAT = 1000;

  function root(text: string, id: number): TelegramUpdate {
    return {
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        text,
        from: { id: OPERATOR, first_name: "op" },
        chat: { id: CHAT, type: "private" },
      },
    };
  }

  function topic(
    threadId: number,
    text: string,
    id: number,
  ): TelegramUpdate {
    return {
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        text,
        from: { id: OPERATOR, first_name: "op" },
        chat: { id: CHAT, type: "private" },
        message_thread_id: threadId,
        is_topic_message: true,
      },
    };
  }

  test("registry: /mcp is topic-scoped", () => {
    expect(COMMANDS.some((c) => c.name === "/mcp")).toBe(true);
    expect(commandAllowedIn("/mcp", "topic")).toBe(true);
    expect(commandAllowedIn("/mcp", "lobby")).toBe(false);
    expect(topicHelpText()).toContain("/mcp");
    expect(parseSlashCommand("/mcp add linear https://x")?.args).toEqual([
      "add",
      "linear",
      "https://x",
    ]);
  });

  test("daemon /mcp add|status|remove on session cwd", async () => {
    await withRepo(
      async () => {},
      async (repo) => {
        const env = createFakeEnvironment({
          config: {
            operatorUserId: OPERATOR,
            operatorChatId: CHAT,
            repos: { demo: repo },
          },
        });
        const daemon = createDaemon(env);
        await daemon.handleUpdate(root("/new demo mcp-reg", 1));
        const session = (await daemon.listSessions())[0]!;
        const thread = session.messageThreadId;

        await daemon.handleUpdate(topic(thread, "/mcp", 2));
        await daemon.handleUpdate(
          topic(thread, "/mcp add linear https://mcp.example/linear", 3),
        );
        await daemon.handleUpdate(topic(thread, "/mcp status", 4));
        await daemon.handleUpdate(topic(thread, "/mcp add", 5));
        await daemon.handleUpdate(topic(thread, "/mcp remove linear", 6));
        await daemon.handleUpdate(topic(thread, "/mcp remove missing", 7));
        await daemon.handleUpdate(topic(thread, "/mcp nope", 8));

        const texts = env.telegram
          .sentMessages()
          .filter((m) => m.messageThreadId === thread)
          .map((m) => m.text ?? "");

        expect(texts.some((t) => t.includes("No MCP servers"))).toBe(true);
        expect(texts.some((t) => t.includes("Added MCP"))).toBe(true);
        expect(
          texts.some(
            (t) =>
              t.includes("linear") && t.includes("https://mcp.example/linear"),
          ),
        ).toBe(true);
        // formatForTelegram may wrap usage in HTML <code>; match command text.
        expect(texts.some((t) => /Usage:.*\/mcp add/s.test(t))).toBe(true);
        expect(texts.some((t) => /Removed MCP.*linear/.test(t))).toBe(true);
        expect(texts.some((t) => /No MCP entry named.*missing/.test(t))).toBe(
          true,
        );
        expect(texts.some((t) => /Usage:.*\/mcp remove/s.test(t))).toBe(true);

        // File never had secrets; after remove, empty or only other entries
        const final = await readMcpConfig(repo);
        expect(final.mcpServers.find((s) => s.name === "linear")).toBeUndefined();
      },
    );
  });
});
