import { describe, expect, test } from "bun:test";
import {
  resetElevenLabsVoiceCache,
  speakableText,
  elevenLabsSpeech,
} from "../src/env/speech-elevenlabs";
import { speechFromEnv } from "../src/env/speech";

describe("speakableText", () => {
  test("strips markdown fences and links", () => {
    expect(speakableText("see [docs](https://x.com) and `code`")).toContain(
      "docs",
    );
    expect(speakableText("```\nnope\n``` hello")).toBe("hello");
  });
});

describe("speechFromEnv", () => {
  test("prefers elevenlabs when ELEVENLABS_API_KEY set", () => {
    const s = speechFromEnv({
      ELEVENLABS_API_KEY: "el-test-key",
      OPENAI_API_KEY: "sk-test",
    });
    expect(s?.tts).toBeDefined();
    expect(s?.stt).toBeDefined();
  });

  test("falls back to openai without elevenlabs", () => {
    const s = speechFromEnv({ OPENAI_API_KEY: "sk-test" });
    expect(s?.tts).toBeDefined();
  });

  test("disabled when TACP_TTS=0 and TACP_STT=0", () => {
    const s = speechFromEnv({
      ELEVENLABS_API_KEY: "el",
      TACP_TTS: "0",
      TACP_STT: "0",
    });
    expect(s).toBeUndefined();
  });
});

describe("elevenLabsSpeech tts", () => {
  test("calls text-to-speech and returns audio bytes", async () => {
    resetElevenLabsVoiceCache();
    let hit = "";
    const speech = elevenLabsSpeech({
      apiKey: "test-key",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      skipFfmpeg: true,
      fetchImpl: async (url, init) => {
        hit = String(url);
        expect(init?.headers).toMatchObject({
          "xi-api-key": "test-key",
        });
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          text?: string;
        };
        expect(body.text).toBe("Hello world");
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      },
    });
    const out = await speech.tts!("Hello world");
    expect(hit).toContain("/v1/text-to-speech/");
    expect(out.data.byteLength).toBe(4);
    expect(out.mimeType).toBe("audio/mpeg");
  });
});
