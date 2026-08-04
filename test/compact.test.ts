import { describe, expect, test } from "bun:test";
import {
  buildCompactPrompt,
  buildScheduleMemoryPreamble,
  memoryFileSlug,
  sessionMemoryRelPath,
} from "../src/core/compact";
import { buildFireEnvelope } from "../src/acp-host/scheduler";
import type { ScheduleJob } from "../src/schedules/types";

describe("compact helpers", () => {
  test("memory path from sessionKey", () => {
    expect(memoryFileSlug("work/life")).toBe("work-life");
    expect(sessionMemoryRelPath("work/life")).toBe(
      ".acpbot/memory/work-life.md",
    );
  });

  test("buildCompactPrompt bare and with focus", () => {
    const bare = buildCompactPrompt({
      sessionKey: "work/life",
      cwd: "/tmp/repo",
    });
    expect(bare).toContain(".acpbot/memory/work-life.md");
    expect(bare).toContain("full useful session context");
    expect(bare).toContain("Do not ask questions");

    const focused = buildCompactPrompt({
      sessionKey: "work/life",
      cwd: "/tmp/repo",
      focus: "family calendar + travel",
    });
    expect(focused).toContain("Operator focus");
    expect(focused).toContain("family calendar + travel");
  });

  test("schedule memory preamble default on", () => {
    const on = buildScheduleMemoryPreamble({ sessionKey: "a/b" });
    expect(on.join("\n")).toContain(".acpbot/memory/");
    const off = buildScheduleMemoryPreamble({
      sessionKey: "a/b",
      enabled: false,
    });
    expect(off).toEqual([]);
  });
});

describe("buildFireEnvelope memory-first", () => {
  const base: ScheduleJob = {
    id: "j1",
    sessionKey: "demo/life",
    prompt: "Send morning brief",
    kind: "once",
    nextRunAt: "2026-08-05T08:00:00.000Z",
    enabled: true,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };

  test("default includes write-memory-first block", () => {
    const text = buildFireEnvelope(base, "/data/demo");
    expect(text).toContain("Before the scheduled task");
    expect(text).toContain(".acpbot/memory/demo-life.md");
    expect(text).toContain("Send morning brief");
  });

  test("writeMemoryFirst false skips preamble", () => {
    const text = buildFireEnvelope(
      { ...base, writeMemoryFirst: false },
      "/data/demo",
    );
    expect(text).not.toContain("Before the scheduled task");
    expect(text).toContain("Send morning brief");
  });
});
