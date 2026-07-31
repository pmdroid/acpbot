/**
 * Agent-controlled TTS via the host MCP `speak` tool.
 *
 * Tool names that end with speak / tts / send_voice / voice
 * (e.g. speak, tacp:speak, mcp__tacp__speak) with { "text": "..." }.
 */

/** Legacy markers still stripped from Telegram text if a model emits them. */
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
  source: "tool" | "always";
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
 * Strip legacy speak markers from assistant text (do not trigger TTS).
 * TTS is MCP `speak` only (or ttsMode=always).
 */
export function stripSpeakMarkers(reply: string): string {
  if (!SPEAK_BLOCK.test(reply)) return reply;
  return reply.replace(SPEAK_BLOCK, "").trim();
}

/**
 * @deprecated Use stripSpeakMarkers. Kept for tests; never returns speak.
 */
export function extractSpeakFromReply(reply: string): {
  visibleText: string;
  speak: undefined;
} {
  return { visibleText: stripSpeakMarkers(reply), speak: undefined };
}
