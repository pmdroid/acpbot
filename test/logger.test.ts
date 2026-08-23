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

  test("sanitizeMeta refuses buffers and redacts imageBase64", () => {
    const jpegPrefix = "/9j/4AAQSkZJRgABAQAAAQABAAD" + "A".repeat(80);
    const s = sanitizeMeta({
      imageBase64: jpegPrefix,
      data: jpegPrefix,
      pixels: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      frame: "not-a-tiny-cap-value-because-it-is-long",
    })!;
    expect(String(s.imageBase64)).not.toContain("/9j/");
    expect(String(s.imageBase64)).toContain("redacted");
    expect(s.pixels).toBe("[bytes 4]");
    expect(String(s.frame)).not.toContain("not-a-tiny-cap-value-because-it-is-long");
    const dumped = JSON.stringify(s);
    expect(dumped).not.toContain("/9j/");
    expect(dumped).not.toContain("ffd8");
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
