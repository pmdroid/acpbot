import { describe, expect, test } from "bun:test";
import {
  buildCompactPrompt,
  memoryFileSlug,
  sessionMemoryAbsPath,
  sessionMemoryRelPath,
} from "../src/core/compact";

describe("compact helpers", () => {
  test("session path helpers", () => {
    expect(memoryFileSlug("work/life")).toBe("work-life");
    expect(sessionMemoryRelPath("work/life")).toBe(
      "memory/sessions/work-life.md",
    );
    expect(sessionMemoryAbsPath("/Users/me/life-repo", "work/life")).toBe(
      "/Users/me/life-repo/memory/sessions/work-life.md",
    );
  });

  test("buildCompactPrompt bare and with focus", () => {
    const bare = buildCompactPrompt({
      sessionKey: "work/life",
      repoRoot: "/tmp/repo",
    });
    expect(bare).toContain("memory_write");
    expect(bare).toContain("memory_read");
    expect(bare).toContain("MEMORY.md");
    expect(bare).toContain("full useful session context");
    expect(bare).toContain("Do not ask questions");

    const focused = buildCompactPrompt({
      sessionKey: "work/life",
      repoRoot: "/tmp/repo",
      focus: "family calendar + travel",
    });
    expect(focused).toContain("Operator focus");
    expect(focused).toContain("family calendar + travel");
  });
});
