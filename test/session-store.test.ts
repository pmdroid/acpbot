import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFileHostSessionStore,
  createMemoryHostSessionStore,
} from "../src/acp/session-store";

describe("HostSessionStore", () => {
  test("memory round-trip", async () => {
    const store = createMemoryHostSessionStore();
    await store.save({
      sessionKey: "demo/a",
      agentSessionId: "sid-1",
      agent: "grok-build",
      cwd: "/tmp/demo",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const loaded = await store.load("demo/a");
    expect(loaded?.agentSessionId).toBe("sid-1");
    expect((await store.list()).map((r) => r.sessionKey)).toEqual(["demo/a"]);
  });

  test("file store survives re-open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tacp-sess-"));
    try {
      const a = createFileHostSessionStore(dir);
      await a.save({
        sessionKey: "repo/topic",
        agentSessionId: "abc",
        agent: "grok-build",
        cwd: "/work",
        modeId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const b = createFileHostSessionStore(dir);
      const loaded = await b.load("repo/topic");
      expect(loaded?.agentSessionId).toBe("abc");
      expect(loaded?.modeId).toBe("default");
      await b.delete("repo/topic");
      expect(await b.load("repo/topic")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
