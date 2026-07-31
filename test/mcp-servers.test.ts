import { describe, expect, test } from "bun:test";
import {
  buildTacpMcpServers,
  defaultTacpMcpServerEntry,
} from "../src/mcp/servers";
import { existsSync } from "node:fs";

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
