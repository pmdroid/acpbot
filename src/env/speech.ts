/**
 * Speech provider wiring for acpbot.
 *
 * TTS and STT are selected independently:
 *   provider = auto | elevenlabs | openai | off
 *
 * `auto` picks ElevenLabs when its API key is present, otherwise OpenAI.
 * OpenAI is a first-class provider (not only a fallback).
 */

import type { Logger } from "./logger";
import {
  elevenLabsKeyFromEnv,
  elevenLabsSpeech,
} from "./speech-elevenlabs";
import { openAiSpeech } from "./speech-openai";
import type { SpeechPort } from "./types";

export type SpeechProviderId = "auto" | "elevenlabs" | "openai" | "off";

export type SpeechSettings = {
  /** Independent TTS provider (default auto). */
  ttsProvider?: SpeechProviderId;
  /** Independent STT provider (default auto). */
  sttProvider?: SpeechProviderId;
  /** When false, STT is off regardless of provider. */
  sttEnabled?: boolean;
  /** When false, TTS is off regardless of provider. */
  ttsEnabled?: boolean;

  elevenlabsApiKey?: string;
  elevenlabsVoiceId?: string;
  elevenlabsTtsModel?: string;
  elevenlabsSttModel?: string;
  elevenlabsBaseUrl?: string;
  elevenlabsStability?: number;
  elevenlabsSimilarityBoost?: number;

  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiTtsModel?: string;
  openaiTtsVoice?: string;
  openaiTtsFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  openaiSttModel?: string;
};

const PROVIDERS = new Set<SpeechProviderId>([
  "auto",
  "elevenlabs",
  "openai",
  "off",
]);

export function parseSpeechProvider(
  raw: unknown,
  fallback: SpeechProviderId = "auto",
): SpeechProviderId {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = String(raw).trim().toLowerCase();
  if (n === "0" || n === "false" || n === "none" || n === "disabled") {
    return "off";
  }
  if (n === "el" || n === "11labs" || n === "eleven") return "elevenlabs";
  if (n === "oai" || n === "gpt") return "openai";
  if (PROVIDERS.has(n as SpeechProviderId)) return n as SpeechProviderId;
  return fallback;
}

/** Build SpeechSettings from process env (legacy + ACPBOT_*). */
export function speechSettingsFromEnv(
  env: Record<string, string | undefined> = process.env,
): SpeechSettings {
  const ttsOff =
    env.ACPBOT_TTS === "0" ||
    env.ACPBOT_TTS === "false";
  const sttOff =
    env.ACPBOT_STT === "0" ||
    env.ACPBOT_STT === "false";

  return {
    ttsProvider: parseSpeechProvider(
      env.ACPBOT_TTS_PROVIDER,
      "auto",
    ),
    sttProvider: parseSpeechProvider(
      env.ACPBOT_STT_PROVIDER,
      "auto",
    ),
    ttsEnabled: ttsOff ? false : undefined,
    sttEnabled: sttOff ? false : undefined,
    elevenlabsApiKey: elevenLabsKeyFromEnv(env),
    elevenlabsVoiceId:
      env.ELEVENLABS_VOICE_ID?.trim() ||
      env.ELEVEN_VOICE_ID?.trim() ||
      env.ACPBOT_ELEVENLABS_VOICE_ID?.trim() ||
      undefined,
    elevenlabsTtsModel:
      env.ELEVENLABS_TTS_MODEL?.trim() ||
      env.ACPBOT_ELEVENLABS_TTS_MODEL?.trim() ||
      undefined,
    elevenlabsSttModel:
      env.ELEVENLABS_STT_MODEL?.trim() ||
      env.ELEVENLABS_MODEL_ID?.trim() ||
      undefined,
    elevenlabsBaseUrl:
      env.ELEVENLABS_BASE_URL?.trim() ||
      env.ACPBOT_ELEVENLABS_BASE_URL?.trim() ||
      undefined,
    elevenlabsStability: env.ELEVENLABS_STABILITY
      ? Number(env.ELEVENLABS_STABILITY)
      : undefined,
    elevenlabsSimilarityBoost: env.ELEVENLABS_SIMILARITY
      ? Number(env.ELEVENLABS_SIMILARITY)
      : undefined,
    openaiApiKey:
      env.OPENAI_API_KEY?.trim() ||
      env.ACPBOT_OPENAI_API_KEY?.trim() ||
      undefined,
    openaiBaseUrl:
      env.ACPBOT_OPENAI_BASE_URL?.trim() ||
      env.OPENAI_BASE_URL?.trim() ||
      undefined,
    openaiTtsModel:
      env.ACPBOT_OPENAI_TTS_MODEL?.trim() ||
      env.OPENAI_TTS_MODEL?.trim() ||
      undefined,
    openaiTtsVoice:
      env.ACPBOT_OPENAI_TTS_VOICE?.trim() ||
      env.ACPBOT_TTS_VOICE?.trim() ||
      env.OPENAI_TTS_VOICE?.trim() ||
      undefined,
    openaiTtsFormat: parseOpenAiFormat(
      env.ACPBOT_OPENAI_TTS_FORMAT ??
        env.OPENAI_TTS_FORMAT,
    ),
    openaiSttModel:
      env.ACPBOT_OPENAI_STT_MODEL?.trim() ||
      env.OPENAI_STT_MODEL?.trim() ||
      undefined,
  };
}

function parseOpenAiFormat(
  raw: string | undefined,
): SpeechSettings["openaiTtsFormat"] {
  if (!raw) return undefined;
  const n = raw.trim().toLowerCase();
  if (
    n === "mp3" ||
    n === "opus" ||
    n === "aac" ||
    n === "flac" ||
    n === "wav" ||
    n === "pcm"
  ) {
    return n;
  }
  return undefined;
}

function resolveProvider(
  requested: SpeechProviderId,
  hasEleven: boolean,
  hasOpenAi: boolean,
): "elevenlabs" | "openai" | undefined {
  if (requested === "off") return undefined;
  if (requested === "elevenlabs") return hasEleven ? "elevenlabs" : undefined;
  if (requested === "openai") return hasOpenAi ? "openai" : undefined;
  // auto
  if (hasEleven) return "elevenlabs";
  if (hasOpenAi) return "openai";
  return undefined;
}

/**
 * Build a SpeechPort from explicit settings (TOML / tests).
 * TTS and STT providers are chosen independently and may differ.
 */
export function speechFromSettings(
  settings: SpeechSettings,
  log?: Logger,
): SpeechPort | undefined {
  const ttsEnabled = settings.ttsEnabled !== false;
  const sttEnabled = settings.sttEnabled !== false;
  if (!ttsEnabled && !sttEnabled) return undefined;

  const ttsReq = parseSpeechProvider(settings.ttsProvider, "auto");
  const sttReq = parseSpeechProvider(settings.sttProvider, "auto");

  const hasEleven = Boolean(settings.elevenlabsApiKey?.trim());
  const hasOpenAi = Boolean(settings.openaiApiKey?.trim());

  let eleven: SpeechPort | undefined;
  if (hasEleven) {
    eleven = elevenLabsSpeech({
      apiKey: settings.elevenlabsApiKey!,
      baseUrl: settings.elevenlabsBaseUrl,
      voiceId: settings.elevenlabsVoiceId,
      ttsModel: settings.elevenlabsTtsModel,
      sttModel: settings.elevenlabsSttModel,
      stability: settings.elevenlabsStability,
      similarityBoost: settings.elevenlabsSimilarityBoost,
      log,
    });
  }

  let openai: SpeechPort | undefined;
  if (hasOpenAi) {
    openai = openAiSpeech({
      apiKey: settings.openaiApiKey!,
      baseUrl: settings.openaiBaseUrl,
      ttsVoice: settings.openaiTtsVoice,
      ttsModel: settings.openaiTtsModel,
      ttsFormat: settings.openaiTtsFormat,
      sttModel: settings.openaiSttModel,
      log,
    });
  }

  const pick = (id: "elevenlabs" | "openai" | undefined) =>
    id === "elevenlabs" ? eleven : id === "openai" ? openai : undefined;

  const ttsId = ttsEnabled
    ? resolveProvider(ttsReq, hasEleven, hasOpenAi)
    : undefined;
  const sttId = sttEnabled
    ? resolveProvider(sttReq, hasEleven, hasOpenAi)
    : undefined;

  const ttsPort = pick(ttsId);
  const sttPort = pick(sttId);

  const tts = ttsPort?.tts;
  const stt = sttPort?.stt;

  if (!tts && !stt) {
    if (
      (ttsReq === "elevenlabs" || sttReq === "elevenlabs") &&
      !hasEleven
    ) {
      log?.warn("speech: elevenlabs selected but elevenlabs_api_key is missing");
    }
    if ((ttsReq === "openai" || sttReq === "openai") && !hasOpenAi) {
      log?.warn("speech: openai selected but openai_api_key is missing");
    }
    return undefined;
  }

  log?.info("speech providers", {
    tts: tts ? ttsId : "off",
    stt: stt ? sttId : "off",
  });

  return { tts, stt };
}

/** Convenience: settings from env, then build port. */
export function speechFromEnv(
  env: Record<string, string | undefined> = process.env,
  log?: Logger,
): SpeechPort | undefined {
  return speechFromSettings(speechSettingsFromEnv(env), log);
}

/**
 * Merge TOML speech block over env defaults (TOML wins for set fields).
 */
export function mergeSpeechSettings(
  fromConfig?: SpeechSettings | null,
  env: Record<string, string | undefined> = process.env,
): SpeechSettings {
  const base = speechSettingsFromEnv(env);
  if (!fromConfig) return base;
  const out: SpeechSettings = { ...base };
  for (const [k, v] of Object.entries(fromConfig) as [
    keyof SpeechSettings,
    SpeechSettings[keyof SpeechSettings],
  ][]) {
    if (v !== undefined && v !== null && v !== "") {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

export function speechFromConfig(
  speech: SpeechSettings | undefined,
  env: Record<string, string | undefined> = process.env,
  log?: Logger,
): SpeechPort | undefined {
  return speechFromSettings(mergeSpeechSettings(speech, env), log);
}
