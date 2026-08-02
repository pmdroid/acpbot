/**
 * OpenAI STT + TTS for acpbot (first-class provider).
 *
 * STT: Whisper / gpt-4o-transcribe family via /audio/transcriptions
 * TTS: tts-1, tts-1-hd, gpt-4o-mini-tts via /audio/speech
 *
 * Select with speech.tts_provider / speech.stt_provider = "openai".
 */

import type { SpeechPort } from "./types";
import type { Logger } from "./logger";
import { silentLogger } from "./logger";

export type OpenAiSpeechOptions = {
  apiKey: string;
  /** Default https://api.openai.com/v1 */
  baseUrl?: string;
  /**
   * TTS voice: alloy | ash | ballad | coral | echo | fable | nova | onyx |
   * sage | shimmer | verse (model-dependent).
   */
  ttsVoice?: string;
  /**
   * STT model. Default whisper-1.
   * Also: gpt-4o-mini-transcribe, gpt-4o-transcribe when available.
   */
  sttModel?: string;
  /**
   * TTS model. Default tts-1.
   * Also: tts-1-hd, gpt-4o-mini-tts.
   */
  ttsModel?: string;
  /** Prefer opus for Telegram voice notes; mp3 is a safe fallback. */
  ttsFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  log?: Logger;
  fetchImpl?: typeof fetch;
};

export function openAiSpeech(options: OpenAiSpeechOptions): SpeechPort {
  const base = (options.baseUrl ?? "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = (options.log ?? silentLogger()).child("speech-openai");
  const sttModel = options.sttModel ?? "whisper-1";
  const ttsModel = options.ttsModel ?? "tts-1";
  const ttsVoice = options.ttsVoice ?? "alloy";
  // opus is ideal for Telegram sendVoice; some OpenAI models prefer mp3
  const ttsFormat = options.ttsFormat ?? "opus";

  return {
    async stt(audio, opts) {
      const boundary = `----acpbot${Date.now().toString(16)}`;
      const enc = new TextEncoder();
      const filename = opts.filename ?? "audio.ogg";
      const parts: Uint8Array[] = [];
      const field = (name: string, value: string) => {
        parts.push(
          enc.encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
          ),
        );
      };
      field("model", sttModel);
      parts.push(
        enc.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${opts.mimeType}\r\n\r\n`,
        ),
      );
      parts.push(audio);
      parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
      let total = 0;
      for (const p of parts) total += p.byteLength;
      const body = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        body.set(p, o);
        o += p.byteLength;
      }

      log.info("stt request", { bytes: audio.byteLength, model: sttModel });
      const res = await fetchImpl(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          `OpenAI STT failed (${res.status}): ${errText.slice(0, 200)}`,
        );
      }
      const json = (await res.json()) as { text?: string };
      return json.text ?? "";
    },

    async tts(text) {
      log.info("tts request", {
        chars: text.length,
        model: ttsModel,
        voice: ttsVoice,
      });
      const res = await fetchImpl(`${base}/audio/speech`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: ttsModel,
          voice: ttsVoice,
          input: text,
          response_format: ttsFormat,
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          `OpenAI TTS failed (${res.status}): ${errText.slice(0, 200)}`,
        );
      }
      const data = new Uint8Array(await res.arrayBuffer());
      const mime =
        ttsFormat === "opus"
          ? "audio/ogg"
          : ttsFormat === "mp3"
            ? "audio/mpeg"
            : `audio/${ttsFormat}`;
      const ext = ttsFormat === "opus" ? "ogg" : ttsFormat;
      return { data, mimeType: mime, filename: `speech.${ext}` };
    },
  };
}

/** @deprecated Use speechFromEnv from ./speech (ElevenLabs-first). Kept for tests. */
export function openAiSpeechFromEnv(
  env: Record<string, string | undefined> = process.env,
  log?: Logger,
): SpeechPort | undefined {
  const apiKey = env.ACPBOT_OPENAI_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  return openAiSpeech({
    apiKey,
    baseUrl: env.ACPBOT_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL,
    ttsVoice: env.ACPBOT_TTS_VOICE,
    log,
  });
}
