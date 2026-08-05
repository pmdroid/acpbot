import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  memoryAbsPath,
  memoryRead,
  memoryRelPath,
  memoryStatus,
  memoryWrite,
  todayUtcDate,
} from "../src/core/memory";
import { buildCompactPrompt } from "../src/core/compact";

describe("memory paths", () => {
  test("rel paths for sections", () => {
    expect(memoryRelPath("memory")).toBe("MEMORY.md");
    expect(memoryRelPath("user")).toBe("USER.md");
    expect(memoryRelPath("daily", { date: "2026-08-04" })).toBe(
      "memory/2026-08-04.md",
    );
    expect(memoryRelPath("session", { sessionKey: "life/main" })).toBe(
      "memory/sessions/life-main.md",
    );
    expect(memoryAbsPath("/repo", "memory")).toBe("/repo/MEMORY.md");
  });
});

describe("memory read/write", () => {
  test("append daily and replace MEMORY", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpbot-mem-"));
    try {
      const w1 = await memoryWrite({
        repoRoot: root,
        section: "daily",
        content: "first note",
        date: "2026-08-04",
        heading: "## t1",
      });
      expect(w1.relPath).toBe("memory/2026-08-04.md");
      expect(w1.mode).toBe("append");

      await memoryWrite({
        repoRoot: root,
        section: "daily",
        content: "second note",
        date: "2026-08-04",
        heading: "## t2",
      });
      const daily = await memoryRead({
        repoRoot: root,
        section: "daily",
        date: "2026-08-04",
      });
      expect(daily.exists).toBe(true);
      expect(daily.content).toContain("first note");
      expect(daily.content).toContain("second note");

      await memoryWrite({
        repoRoot: root,
        section: "memory",
        content: "# Memory\n\n- durable fact",
        mode: "replace",
      });
      const mem = await memoryRead({ repoRoot: root, section: "memory" });
      expect(mem.content).toContain("durable fact");
      expect(mem.content).not.toContain("first note");

      const st = await memoryStatus({
        repoRoot: root,
        sessionKey: "life/main",
      });
      expect(st.find((s) => s.section === "memory")?.exists).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("compact prompt uses memory tools", () => {
  test("mentions memory_write and repo layout", () => {
    const p = buildCompactPrompt({
      sessionKey: "life/main",
      repoRoot: "/tmp/life",
    });
    expect(p).toContain("memory_write");
    expect(p).toContain("memory_read");
    expect(p).toContain("MEMORY.md");
    expect(p).toContain(`memory/${todayUtcDate()}.md`);
  });
});
