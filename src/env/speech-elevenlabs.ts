/**
 * ElevenLabs STT (Scribe) + TTS — same approach as Ursula/Kyoto plugins/elevenlabs.
 * Free tier: premade/cloned voices only (not Voice Library).
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "./logger";
import { silentLogger } from "./logger";
import type { SpeechPort } from "./types";

export type ElevenLabsSpeechOptions = {
  apiKey: string;
  baseUrl?: string;
  voiceId?: string;
  ttsModel?: string;
  sttModel?: string;
  stability?: number;
  similarityBoost?: number;
  log?: Logger;
  fetchImpl?: typeof fetch;
  /** Skip ffmpeg ogg conversion (tests). */
  skipFfmpeg?: boolean;
};

/**
 * Classic premade IDs (not Voice Library) used only as fallbacks when the
 * configured voice fails. Preferred voice comes from ELEVENLABS_VOICE_ID.
 */
const PREMADE_FALLBACK_VOICES = [
  "EST9Ui6982FZPSi7gCHi", // operator-selected default
  "EXAVITQu4vr4xnSDxMaL", // Bella
  "pNInz6obpgDQGcFmaJgB", // Adam
  "ErXwobaYiN019PkySvjV", // Antoni
  "MF3mGyEYCl7XYWbV9V6O", // Elli
  "TxGEqnHWrfWFTfGW9XjX", // Josh
  "yoZ06aMxZJJ28mfd3POQ", // Sam
  "21m00Tcm4TlvDq8ikWAM", // Rachel (may 402 on free tier)
];

function isLibraryVoiceError(status: number, body: string): boolean {
  if (status !== 402 && status !== 401 && status !== 403) return false;
  return /paid_plan_required|library voice|free users cannot|payment_required/i.test(
    body,
  );
}

type VoiceListItem = {
  voice_id?: string;
  category?: string;
};

let cachedAccountVoices: string[] | null = null;

async function listAccountPremadeVoiceIds(
  apiKey: string,
  base: string,
  fetchImpl: typeof fetch,
  log: Logger,
): Promise<string[]> {
  if (cachedAccountVoices) return cachedAccountVoices;
  try {
    const res = await fetchImpl(`${base}/v1/voices`, {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) {
      log.warn("elevenlabs list voices HTTP", { status: res.status });
      cachedAccountVoices = [];
      return [];
    }
    const data = (await res.json()) as { voices?: VoiceListItem[] };
    const ids: string[] = [];
    for (const v of data.voices ?? []) {
      if (!v.voice_id) continue;
      const cat = (v.category || "").toLowerCase();
      if (
        cat === "premade" ||
        cat === "cloned" ||
        cat === "generated" ||
        cat === "professional"
      ) {
        ids.push(v.voice_id);
      }
    }
    cachedAccountVoices = ids;
    if (ids.length) {
      log.info("elevenlabs account voices", { count: ids.length });
    }
    return ids;
  } catch (e) {
    log.warn("elevenlabs list voices failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    cachedAccountVoices = [];
    return [];
  }
}

function voiceCandidates(
  preferred: string | null | undefined,
  accountIds: string[],
): string[] {
  const out: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && !out.includes(id)) out.push(id);
  };
  add(preferred);
  for (const id of accountIds) add(id);
  for (const id of PREMADE_FALLBACK_VOICES) add(id);
  return out;
}

function friendlyTtsError(status: number, body: string): string {
  if (isLibraryVoiceError(status, body)) {
    return (
      "ElevenLabs free tier cannot use Voice Library voices via API. " +
      "Set ELEVENLABS_VOICE_ID to a premade/cloned voice, or upgrade."
    );
  }
  if (status === 401) return "ElevenLabs TTS: invalid API key";
  if (status === 429) return "ElevenLabs TTS: rate limited — try again shortly";
  return `ElevenLabs TTS HTTP ${status}: ${body.slice(0, 200)}`;
}

/** Strip markdown noise so TTS sounds natural (Ursula speakableText-lite). */
export function speakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function tryFfmpegOpus(
  mp3: Uint8Array,
  log: Logger,
): Promise<Uint8Array | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "tacp-tts-"));
  const mp3Path = join(dir, "in.mp3");
  const oggPath = join(dir, "out.ogg");
  try {
    await writeFile(mp3Path, mp3);
    const code = await new Promise<number>((resolve) => {
      const ff = spawn(
        "ffmpeg",
        ["-y", "-i", mp3Path, "-c:a", "libopus", "-b:a", "48k", "-vbr", "on", oggPath],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      ff.on("error", () => resolve(127));
      ff.on("close", (c) => resolve(c ?? 1));
    });
    if (code !== 0) {
      log.debug("ffmpeg opus convert skipped/failed", { code });
      return undefined;
    }
    return new Uint8Array(await readFile(oggPath));
  } catch {
    return undefined;
  } finally {
    try {
      await unlink(mp3Path);
    } catch {
      /* */
    }
    try {
      await unlink(oggPath);
    } catch {
      /* */
    }
  }
}

export function elevenLabsSpeech(
  options: ElevenLabsSpeechOptions,
): SpeechPort {
  const base = (
    options.baseUrl ?? "https://api.elevenlabs.io"
  ).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = (options.log ?? silentLogger()).child("elevenlabs");
  const ttsModel = options.ttsModel ?? "eleven_multilingual_v2";
  const sttModel = options.sttModel ?? "scribe_v1";
  const stability = options.stability ?? 0.4;
  const similarity = options.similarityBoost ?? 0.75;

  return {
    async stt(audio, opts) {
      const form = new FormData();
      const filename = opts.filename ?? "voice.ogg";
      form.append(
        "file",
        new Blob([audio], { type: opts.mimeType }),
        filename,
      );
      form.append("model_id", sttModel);
      log.info("stt request", { bytes: audio.byteLength, model: sttModel });
      const res = await fetchImpl(`${base}/v1/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": options.apiKey },
        body: form,
      });
      const body = await res.text();
      if (!res.ok) {
        throw new Error(
          `ElevenLabs STT HTTP ${res.status}: ${body.slice(0, 500)}`,
        );
      }
      try {
        const json = JSON.parse(body) as {
          text?: string;
          transcription?: string;
        };
        const text = (json.text || json.transcription || "").trim();
        if (!text) throw new Error(`empty STT: ${body.slice(0, 200)}`);
        return text;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("empty")) throw e;
        const text = body.trim();
        if (!text) throw new Error("ElevenLabs empty body");
        return text;
      }
    },

    async tts(text) {
      const cleaned = speakableText(text);
      if (!cleaned) throw new Error("Nothing speakable after cleanup");

      log.info("tts request", {
        chars: cleaned.length,
        model: ttsModel,
        voice: options.voiceId ?? "(auto)",
      });

      const preferred = options.voiceId ?? null;
      let accountIds: string[] = [];
      let candidates = voiceCandidates(preferred, accountIds);
      let lastErr = "";
      let audio: Uint8Array | null = null;

      for (let i = 0; i < candidates.length; i++) {
        const voice = candidates[i]!;
        const res = await fetchImpl(`${base}/v1/text-to-speech/${voice}`, {
          method: "POST",
          headers: {
            "xi-api-key": options.apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: cleaned,
            model_id: ttsModel,
            voice_settings: {
              stability,
              similarity_boost: similarity,
            },
          }),
        });
        if (res.ok) {
          audio = new Uint8Array(await res.arrayBuffer());
          if (preferred && voice !== preferred) {
            log.warn("elevenlabs voice fallback", {
              preferred,
              used: voice,
            });
          }
          break;
        }
        const body = (await res.text()).slice(0, 500);
        lastErr = `HTTP ${res.status}: ${body}`;

        if (isLibraryVoiceError(res.status, body)) {
          if (accountIds.length === 0) {
            accountIds = await listAccountPremadeVoiceIds(
              options.apiKey,
              base,
              fetchImpl,
              log,
            );
            for (const id of voiceCandidates(null, accountIds)) {
              if (!candidates.includes(id)) candidates.push(id);
            }
          }
          log.warn("elevenlabs voice not allowed on plan", { voice });
          continue;
        }
        throw new Error(friendlyTtsError(res.status, body));
      }

      if (!audio) {
        throw new Error(
          friendlyTtsError(402, lastErr) ||
            "ElevenLabs TTS failed: no usable free-tier voice. Set ELEVENLABS_VOICE_ID.",
        );
      }

      if (!options.skipFfmpeg) {
        const ogg = await tryFfmpegOpus(audio, log);
        if (ogg) {
          return {
            data: ogg,
            mimeType: "audio/ogg",
            filename: "speech.ogg",
          };
        }
      }

      return {
        data: audio,
        mimeType: "audio/mpeg",
        filename: "speech.mp3",
      };
    },
  };
}

export function elevenLabsKeyFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    env.ELEVENLABS_API_KEY?.trim() ||
    env.ELEVEN_API_KEY?.trim() ||
    env.XI_API_KEY?.trim() ||
    env.TACP_ELEVENLABS_API_KEY?.trim() ||
    undefined
  );
}

/** Reset voice cache (tests). */
export function resetElevenLabsVoiceCache(): void {
  cachedAccountVoices = null;
}
