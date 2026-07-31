import { describe, expect, test } from "bun:test";
import {
  extractSpeakFromReply,
  isSpeakToolName,
  speakTextFromToolInput,
  stripSpeakMarkers,
} from "../src/core/speak";

describe("stripSpeakMarkers", () => {
  test("no marker leaves text alone", () => {
    expect(stripSpeakMarkers("Hello only")).toBe("Hello only");
  });

  test("strips marker block without requesting TTS", () => {
    const r = extractSpeakFromReply("Hi there.\n\n<<<speak>>>\n");
    expect(r.speak).toBeUndefined();
    expect(r.visibleText).toBe("Hi there.");
  });

  test("strips marker and override body from visible text", () => {
    const r = extractSpeakFromReply(
      "Long explanation.\n\n<<<speak>>>\nShort voice line\n",
    );
    expect(r.speak).toBeUndefined();
    expect(r.visibleText).toContain("Long explanation");
    expect(r.visibleText).not.toContain("<<<speak>>>");
    expect(r.visibleText).not.toContain("Short voice line");
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
