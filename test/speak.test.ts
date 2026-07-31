import { describe, expect, test } from "bun:test";
import {
  extractSpeakFromReply,
  isSpeakToolName,
  parseTtsMode,
  speakTextFromToolInput,
} from "../src/core/speak";

describe("extractSpeakFromReply", () => {
  test("no marker", () => {
    const r = extractSpeakFromReply("Hello only");
    expect(r.speak).toBeUndefined();
    expect(r.visibleText).toBe("Hello only");
  });

  test("marker without body uses full reply", () => {
    const r = extractSpeakFromReply("Hi there.\n\n<<<speak>>>\n");
    expect(r.speak?.source).toBe("marker");
    expect(r.speak?.text).toBeUndefined();
    expect(r.visibleText).toBe("Hi there.");
  });

  test("marker with override text", () => {
    const r = extractSpeakFromReply(
      "Long explanation.\n\n<<<speak>>>\nShort voice line\n",
    );
    expect(r.speak?.text).toBe("Short voice line");
    expect(r.visibleText).toContain("Long explanation");
    expect(r.visibleText).not.toContain("<<<speak>>>");
  });
});

describe("speak tools", () => {
  test("isSpeakToolName", () => {
    expect(isSpeakToolName("speak")).toBe(true);
    expect(isSpeakToolName("tts")).toBe(true);
    expect(isSpeakToolName("send_voice")).toBe(true);
    expect(isSpeakToolName("tacp:speak")).toBe(true);
    expect(isSpeakToolName("mcp__tacp__speak")).toBe(true);
    expect(isSpeakToolName("Bash")).toBe(false);
  });

  test("speakTextFromToolInput", () => {
    expect(speakTextFromToolInput({ text: "hi" })).toBe("hi");
    expect(speakTextFromToolInput({ arguments: { message: "yo" } })).toBe(
      "yo",
    );
  });
});

describe("parseTtsMode", () => {
  test("defaults to agent", () => {
    expect(parseTtsMode(undefined)).toBe("agent");
    expect(parseTtsMode("always")).toBe("always");
    expect(parseTtsMode("off")).toBe("off");
  });
});
