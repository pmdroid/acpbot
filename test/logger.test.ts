import { describe, expect, test } from "bun:test";
import {
  createLogger,
  parseLogLevel,
  sanitizeMeta,
  summarizeUpdate,
} from "../src/env/logger";

describe("logger", () => {
  test("parseLogLevel respects verbose and names", () => {
    expect(parseLogLevel(undefined, true)).toBe("debug");
    expect(parseLogLevel("warn")).toBe("warn");
    expect(parseLogLevel("nope")).toBe("info");
  });

  test("sanitizeMeta redacts tokens and truncates long strings", () => {
    const s = sanitizeMeta({
      botToken: "secret-value",
      text: "x".repeat(600),
      ok: 1,
    })!;
    expect(s.botToken).toBe("[redacted]");
    expect(String(s.text).startsWith("xxx")).toBe(true);
    expect(String(s.text).includes("+")).toBe(true);
    expect(s.ok).toBe(1);
  });

  test("summarizeUpdate for message and callback", () => {
    expect(
      summarizeUpdate({
        update_id: 1,
        message: {
          text: "/ping",
          from: { id: 9 },
          chat: { id: 1 },
        },
      }).kind,
    ).toBe("message");
    expect(
      summarizeUpdate({
        update_id: 2,
        callback_query: { data: "n:0", from: { id: 9 } },
      }).kind,
    ).toBe("callback_query");
  });

  test("createLogger emits at level", () => {
    const lines: string[] = [];
    const log = createLogger({
      level: "info",
      name: "test",
      write: (l) => lines.push(l),
    });
    log.debug("nope");
    log.info("yes", { a: 1 });
    expect(lines.some((l) => l.includes("yes") && l.includes('"a":1'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("nope"))).toBe(false);
  });
});
