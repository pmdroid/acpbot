/**
 * Speech provider wiring for acpbot.
 * TTS: ElevenLabs (Ursula-style) when ELEVENLABS_API_KEY is set.
 * STT: ElevenLabs Scribe with same key; optional OpenAI Whisper fallback.
 */

import type { Logger } from "./logger";
import {
  elevenLabsKeyFromEnv,
  elevenLabsSpeech,
} from "./speech-elevenlabs";
import { openAiSpeech } from "./speech-openai";
import type { SpeechPort } from "./types";

export function speechFromEnv(
  env: Record<string, string | undefined> = process.env,
  log?: Logger,
): SpeechPort | undefined {
  const sttOff = env.TACP_STT === "0" || env.TACP_STT === "false";
  const ttsOff = env.TACP_TTS === "0" || env.TACP_TTS === "false";
  if (sttOff && ttsOff) return undefined;

  const elevenKey = elevenLabsKeyFromEnv(env);
  const openaiKey = env.TACP_OPENAI_API_KEY ?? env.OPENAI_API_KEY;

  let eleven: SpeechPort | undefined;
  if (elevenKey) {
    eleven = elevenLabsSpeech({
      apiKey: elevenKey,
      baseUrl: env.ELEVENLABS_BASE_URL ?? env.TACP_ELEVENLABS_BASE_URL,
      voiceId:
        env.ELEVENLABS_VOICE_ID?.trim() ||
        env.ELEVEN_VOICE_ID?.trim() ||
        env.TACP_ELEVENLABS_VOICE_ID?.trim() ||
        "EST9Ui6982FZPSi7gCHi",
      ttsModel:
        env.ELEVENLABS_TTS_MODEL?.trim() ||
        env.TACP_ELEVENLABS_TTS_MODEL?.trim() ||
        undefined,
      sttModel:
        env.ELEVENLABS_STT_MODEL?.trim() ||
        env.ELEVENLABS_MODEL_ID?.trim() ||
        undefined,
      stability: env.ELEVENLABS_STABILITY
        ? Number(env.ELEVENLABS_STABILITY)
        : undefined,
      similarityBoost: env.ELEVENLABS_SIMILARITY
        ? Number(env.ELEVENLABS_SIMILARITY)
        : undefined,
      log,
    });
  }

  let openai: SpeechPort | undefined;
  if (openaiKey) {
    openai = openAiSpeech({
      apiKey: openaiKey,
      baseUrl: env.TACP_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL,
      ttsVoice: env.TACP_TTS_VOICE,
      log,
    });
  }

  // Prefer ElevenLabs for both when available (Ursula); OpenAI only as STT fallback.
  const tts = !ttsOff ? (eleven?.tts ?? openai?.tts) : undefined;
  const stt = !sttOff ? (eleven?.stt ?? openai?.stt) : undefined;

  if (!tts && !stt) return undefined;
  return { tts, stt };
}
