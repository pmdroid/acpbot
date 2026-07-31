import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  messageHasMedia,
  messageTextOrCaption,
  pickMediaRef,
  prepareAgentMedia,
  textForTts,
} from "../src/core/media";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { TelegramUpdate } from "../src/env/types";

const OPERATOR = 42;
const CHAT = 1000;

function root(text: string, id: number): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      text,
      from: { id: OPERATOR, first_name: "op" },
      chat: { id: CHAT, type: "private" },
    },
  };
}

describe("media helpers", () => {
  test("pick photo largest and caption", () => {
    const msg = {
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private" },
      caption: "see this",
      photo: [
        { file_id: "small", file_size: 10 },
        { file_id: "big", file_size: 999 },
      ],
    };
    expect(messageHasMedia(msg)).toBe(true);
    expect(messageTextOrCaption(msg)).toBe("see this");
    expect(pickMediaRef(msg)?.fileId).toBe("big");
  });

  test("textForTts truncates", () => {
    expect(textForTts("a".repeat(2000), 100).length).toBeLessThanOrEqual(100);
  });

  test("prepareAgentMedia saves images to inbox by default (no ACP block)", async () => {
    const cwd = join(import.meta.dir, "../.scratch-media");
    await mkdir(cwd, { recursive: true });
    const env = createFakeEnvironment();
    const prepared = await prepareAgentMedia({
      msg: {
        message_id: 1,
        date: 0,
        chat: { id: 1, type: "private" },
        caption: "diagram",
        photo: [{ file_id: "img1", file_size: 100 }],
      },
      telegram: env.telegram,
      sessionCwd: cwd,
    });
    expect(prepared.text).toContain("diagram");
    expect(prepared.text).toContain(".tacp-inbox");
    expect(prepared.attachments).toHaveLength(0);
    expect(prepared.notes.some((n) => n.includes("acp image blocks off"))).toBe(
      true,
    );
  });

  test("prepareAgentMedia can enable ACP image blocks when requested", async () => {
    const cwd = join(import.meta.dir, "../.scratch-media-acp");
    await mkdir(cwd, { recursive: true });
    const env = createFakeEnvironment();
    const prepared = await prepareAgentMedia({
      msg: {
        message_id: 1,
        date: 0,
        chat: { id: 1, type: "private" },
        photo: [{ file_id: "img2", file_size: 100 }],
      },
      telegram: env.telegram,
      sessionCwd: cwd,
      acpMediaAttachments: true,
    });
    expect(prepared.attachments).toHaveLength(1);
    expect(prepared.attachments[0]!.mediaType).toBe("image/jpeg");
  });

  test("prepareAgentMedia STT on voice without ACP audio by default", async () => {
    const cwd = join(import.meta.dir, "../.scratch-media-voice");
    await mkdir(cwd, { recursive: true });
    const env = createFakeEnvironment();
    const prepared = await prepareAgentMedia({
      msg: {
        message_id: 1,
        date: 0,
        chat: { id: 1, type: "private" },
        voice: { file_id: "v1", mime_type: "audio/ogg" },
      },
      telegram: env.telegram,
      sessionCwd: cwd,
      speech: {
        stt: async () => "hello from voice",
      },
    });
    expect(prepared.text).toContain("hello from voice");
    expect(prepared.text).toContain(".tacp-inbox");
    expect(prepared.attachments).toHaveLength(0);
  });
});

describe("daemon media + TTS", () => {
  test("photo in topic reaches agent with attachment", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: join(import.meta.dir, "../.scratch-media-demo") },
      },
    });
    await mkdir(join(import.meta.dir, "../.scratch-media-demo"), {
      recursive: true,
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new demo media", 1));
    const session = (await daemon.listSessions())[0]!;

    env.agents.queueTurn("demo/media", {
      events: [
        { type: "turn_started" },
        { type: "agent_message_chunk", text: "I see the image" },
        { type: "turn_ended" },
      ],
    });

    await daemon.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 0,
        caption: "what is this?",
        from: { id: OPERATOR, first_name: "op" },
        chat: { id: CHAT, type: "private" },
        message_thread_id: session.messageThreadId,
        is_topic_message: true,
        photo: [{ file_id: "photo-abc", file_size: 50 }],
      },
    });

    // drain
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await Bun.sleep(30);

    expect(env.agents.turns).toHaveLength(1);
    expect(env.agents.turns[0]!.input.text).toContain("what is this?");
    expect(env.agents.turns[0]!.input.text).toContain(".tacp-inbox");
    // Default: no ACP image blocks (Grok lacks promptCapabilities.image)
    expect(env.agents.turns[0]!.input.attachments?.length ?? 0).toBe(0);
  });

  test("TTS only when agent requests speak (marker), not always", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: join(import.meta.dir, "../.scratch-media-tts") },
        ttsMode: "agent",
      },
    });
    await mkdir(join(import.meta.dir, "../.scratch-media-tts"), {
      recursive: true,
    });
    env.speech = {
      tts: async () => ({
        data: new TextEncoder().encode("fake-ogg"),
        mimeType: "audio/ogg",
        filename: "speech.ogg",
      }),
    };

    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new demo tts", 1));
    const session = (await daemon.listSessions())[0]!;

    // No speak marker → no voice
    env.agents.queueTurn("demo/tts", {
      events: [
        { type: "turn_started" },
        { type: "agent_message_chunk", text: "Plain text only" },
        { type: "turn_ended" },
      ],
    });
    await daemon.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 0,
        text: "hi",
        from: { id: OPERATOR, first_name: "op" },
        chat: { id: CHAT, type: "private" },
        message_thread_id: session.messageThreadId,
        is_topic_message: true,
      },
    });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await Bun.sleep(40);
    expect(
      env.telegram.outbound.filter((c) => c.method === "sendVoice"),
    ).toHaveLength(0);

    // With <<<speak>>> → voice
    env.telegram.clearOutbound();
    env.agents.queueTurn("demo/tts", {
      events: [
        { type: "turn_started" },
        {
          type: "agent_message_chunk",
          text: "I'll say this out loud.\n\n<<<speak>>>\n",
        },
        { type: "turn_ended" },
      ],
    });
    await daemon.handleUpdate({
      update_id: 3,
      message: {
        message_id: 3,
        date: 0,
        text: "say hi",
        from: { id: OPERATOR, first_name: "op" },
        chat: { id: CHAT, type: "private" },
        message_thread_id: session.messageThreadId,
        is_topic_message: true,
      },
    });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await Bun.sleep(50);
    expect(
      env.telegram.outbound.filter((c) => c.method === "sendVoice").length,
    ).toBeGreaterThanOrEqual(1);
    const textOut = env.telegram
      .sentMessages()
      .map((m) => m.text ?? "")
      .join("\n");
    expect(textOut).toContain("I'll say this out loud");
    expect(textOut).not.toContain("<<<speak>>>");
  });
});
