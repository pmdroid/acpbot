/**
 * Agent-controlled TTS: the model decides whether to speak.
 *
 * Conventions (any one is enough):
 * 1) Explicit block in the assistant message (stripped before Telegram text):
 *      <<<speak>>>
 *      optional override text
 *      <<<
 *    Empty body → speak the rest of the reply (after stripping the block).
 *
 * 2) MCP / tool call whose name ends with speak / tts / send_voice / voice
 *    (e.g. speak, tacp:speak, mcp__tacp__speak) with { "text": "..." }.
 */

/** Opening tag; body until closing tag or end of message. */
const SPEAK_BLOCK =
  /<<<\s*speak\s*>>>\s*([\s\S]*?)(?:<<<\s*\/\s*speak\s*>>>|<<<\s*end\s*>>>|(?=\n*<<<)|$)/i;

const SPEAK_TOOL =
  /^(speak|tts|send[_-]?voice|voice[_-]?note|voice)$/i;

export type SpeakRequest = {
  /**
   * Text to synthesize.
   * - omitted / undefined → use full visible reply
   * - "" after mid-turn MCP delivery → already spoken (skip end-of-turn TTS)
   */
  text?: string | undefined;
  source: "marker" | "tool";
};

export function isSpeakToolName(name: string | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  // MCP clients may prefix: tacp:speak, mcp__tacp__speak, tools/speak
  const parts = trimmed.split(/[\/:_]+/).filter(Boolean);
  const base = parts[parts.length - 1] ?? trimmed;
  return SPEAK_TOOL.test(base) || SPEAK_TOOL.test(trimmed);
}

/** Extract text from common tool input shapes. */
export function speakTextFromToolInput(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t || undefined;
  }
  if (typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  for (const key of ["text", "message", "content", "speech", "utterance"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // Nested arguments (some tool wrappers)
  if (o.arguments && typeof o.arguments === "object") {
    return speakTextFromToolInput(o.arguments);
  }
  if (o.input && typeof o.input === "object") {
    return speakTextFromToolInput(o.input);
  }
  return undefined;
}

/**
 * Strip speak markers from assistant text and return whether to TTS.
 */
export function extractSpeakFromReply(reply: string): {
  visibleText: string;
  speak: SpeakRequest | undefined;
} {
  const m = reply.match(SPEAK_BLOCK);
  if (!m) {
    return { visibleText: reply, speak: undefined };
  }
  const override = (m[1] ?? "").trim();
  const visibleText = reply.replace(SPEAK_BLOCK, "").trim();
  return {
    visibleText,
    speak: {
      source: "marker",
      text: override || undefined,
    },
  };
}

export type TtsMode = "off" | "always" | "agent";

export function parseTtsMode(raw: string | undefined): TtsMode {
  const n = (raw ?? "agent").trim().toLowerCase();
  if (n === "off" || n === "0" || n === "false" || n === "never") return "off";
  if (n === "always" || n === "1" || n === "true" || n === "on") return "always";
  return "agent";
}
