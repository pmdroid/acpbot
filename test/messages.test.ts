import { describe, expect, test } from "bun:test";
import { chunkForTelegram } from "../src/core/messages";

describe("telegram chunking", () => {
  test("short text is one chunk", () => {
    expect(chunkForTelegram("hi")).toEqual(["hi"]);
  });

  test("long text splits under the limit", () => {
    const body = "word ".repeat(1000);
    const chunks = chunkForTelegram(body, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toContain("word");
  });
});
