import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileHostSessionStore,
  createMemoryHostSessionStore,
  parseSessionRecordJson,
} from "../src/acp/session-store";

const sample = {
  sessionKey: "sxm/main",
  agentSessionId: "019fee9e-74aa-7d41-9dfc-cf6ae3dc2a18",
  agent: "grok-build",
  cwd: "/Users/pascal/work/sxm",
  modeId: "default",
  modelId: "grok-4.5",
  createdAt: "2026-08-11T02:19:50.484Z",
  updatedAt: "2026-08-11T17:11:42.213Z",
};

describe("HostSessionStore", () => {
  test("memory round-trip", async () => {
    const store = createMemoryHostSessionStore();
    await store.save(sample);
    const loaded = await store.load("sxm/main");
    expect(loaded?.agentSessionId).toBe(sample.agentSessionId);
  });

  test("file store persists across instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sess-store-"));
    try {
      const a = createFileHostSessionStore(dir);
      await a.save(sample);
      const b = createFileHostSessionStore(dir);
      const loaded = await b.load("sxm/main");
      expect(loaded).toEqual(sample);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("parseSessionRecordJson strips trailing NULs from truncated crash", () => {
    // Real corruption: missing closing brace + NULs (interrupted write race).
    const bad =
      '{\n  "sessionKey": "sxm/main",\n  "agentSessionId": "abc",\n  "agent": "grok-build",\n  "cwd": "/x",\n  "createdAt": "t",\n  "updatedAt": "u"\n}\x00\x00\x00';
    const ok = parseSessionRecordJson(bad);
    expect(ok?.sessionKey).toBe("sxm/main");
  });

  test("parseSessionRecordJson returns undefined for broken JSON", () => {
    const truncated =
      '{\n  "sessionKey": "sxm/main",\n  "updatedAt": "2026-08-11T17:11:42.213Z"\x00\x00\x00';
    expect(parseSessionRecordJson(truncated)).toBeUndefined();
  });

  test("file load quarantines corrupt record instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sess-corrupt-"));
    try {
      const sessionsDir = join(dir, "sessions");
      await mkdir(sessionsDir, { recursive: true });
      const file = join(sessionsDir, `${encodeURIComponent("sxm/main")}.json`);
      await writeFile(
        file,
        '{\n  "sessionKey": "sxm/main",\n  "updatedAt": "t"\x00\x00\x00',
        "utf8",
      );
      const store = createFileHostSessionStore(dir);
      const loaded = await store.load("sxm/main");
      expect(loaded).toBeUndefined();
      // Original removed so ensure can session/new
      await expect(readFile(file, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("concurrent saves leave valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sess-race-"));
    try {
      const store = createFileHostSessionStore(dir);
      await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          store.save({
            ...sample,
            updatedAt: new Date(1_700_000_000_000 + i).toISOString(),
            modelId: `m-${i}`,
          }),
        ),
      );
      const loaded = await store.load("sxm/main");
      expect(loaded?.sessionKey).toBe("sxm/main");
      expect(loaded?.agentSessionId).toBe(sample.agentSessionId);
      expect(loaded?.modelId).toMatch(/^m-\d+$/);
      const raw = await readFile(
        join(dir, "sessions", encodeURIComponent("sxm/main") + ".json"),
        "utf8",
      );
      expect(raw.includes("\u0000")).toBe(false);
      expect(() => JSON.parse(raw)).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
