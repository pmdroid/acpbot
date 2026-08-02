import { describe, expect, test } from "bun:test";
import {
  isSpeakToolName,
  speakTextFromToolInput,
  stripSpeakMarkers,
} from "../src/core/speak";

describe("stripSpeakMarkers", () => {
  test("no marker leaves text alone", () => {
    expect(stripSpeakMarkers("Hello only")).toBe("Hello only");
  });

  test("strips marker block from visible text", () => {
    expect(stripSpeakMarkers("Hi there.\n\n<<<speak>>>\n")).toBe("Hi there.");
  });

  test("strips marker and body from visible text", () => {
    const visible = stripSpeakMarkers(
      "Long explanation.\n\n<<<speak>>>\nShort voice line\n",
    );
    expect(visible).toContain("Long explanation");
    expect(visible).not.toContain("<<<speak>>>");
    expect(visible).not.toContain("Short voice line");
  });
});

describe("speak tools", () => {
  test("isSpeakToolName", () => {
    expect(isSpeakToolName("speak")).toBe(true);
    expect(isSpeakToolName("tts")).toBe(true);
    expect(isSpeakToolName("send_voice")).toBe(true);
    expect(isSpeakToolName("acpbot:speak")).toBe(true);
    expect(isSpeakToolName("mcp__acpbot__speak")).toBe(true);
    expect(isSpeakToolName("Bash")).toBe(false);
  });

  test("speakTextFromToolInput", () => {
    expect(speakTextFromToolInput({ text: "hi" })).toBe("hi");
    expect(speakTextFromToolInput({ arguments: { message: "yo" } })).toBe(
      "yo",
    );
  });
});
