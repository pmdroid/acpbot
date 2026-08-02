import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { TelegramUpdate } from "../src/env/types";
import {
  basenameOf,
  resolvePathUnderRepo,
  TELEGRAM_PHOTO_MAX_BYTES,
} from "../src/mcp/repo-path";
import {
  isTelegramFileToolName,
  isTelegramMessageToolName,
  isTelegramOutboundToolName,
  isTelegramPhotoToolName,
  isTelegramTextToolName,
  isTelegramUpdateToolName,
  telegramTextFromToolInput,
} from "../src/core/telegram-tools";

const OPERATOR = 9;
const CHAT = 10;

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

describe("repo-path", () => {
  test("resolves relative path under repo and rejects escapes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "repo-"));
    await mkdir(join(rootDir, "out"), { recursive: true });
    const file = join(rootDir, "out", "a.png");
    await writeFile(file, "png-bytes");

    const ok = resolvePathUnderRepo(rootDir, "out/a.png");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.size).toBe(9);
      expect(ok.rel.replace(/\\/g, "/")).toBe("out/a.png");
    }

    const escape = resolvePathUnderRepo(rootDir, "../secret");
    expect(escape.ok).toBe(false);

    const missing = resolvePathUnderRepo(rootDir, "nope.bin");
    expect(missing.ok).toBe(false);

    expect(basenameOf("/a/b/c.txt")).toBe("c.txt");
    expect(TELEGRAM_PHOTO_MAX_BYTES).toBeGreaterThan(1_000_000);

    await rm(rootDir, { recursive: true, force: true });
  });
});

describe("telegram tool name detection", () => {
  test("matches update / telegram_send prefixes", () => {
    expect(isTelegramUpdateToolName("update")).toBe(true);
    expect(isTelegramUpdateToolName("mcp__acpbot__update")).toBe(true);
    expect(isTelegramUpdateToolName("acpbot:update")).toBe(true);
    expect(isTelegramUpdateToolName("progress")).toBe(true);
    expect(isTelegramMessageToolName("telegram_send")).toBe(true);
    expect(isTelegramMessageToolName("mcp__acpbot__telegram_send")).toBe(true);
    expect(isTelegramTextToolName("speak")).toBe(false);
    expect(telegramTextFromToolInput({ text: " hi " })).toBe("hi");
  });

  test("matches photo and file tool names", () => {
    expect(isTelegramPhotoToolName("telegram_send_photo")).toBe(true);
    expect(isTelegramPhotoToolName("mcp__acpbot__telegram_send_photo")).toBe(
      true,
    );
    expect(isTelegramFileToolName("telegram_send_file")).toBe(true);
    expect(isTelegramFileToolName("telegram_send_document")).toBe(true);
    expect(isTelegramOutboundToolName("telegram_send_photo")).toBe(true);
    expect(isTelegramOutboundToolName("telegram_send_file")).toBe(true);
    expect(isTelegramOutboundToolName("speak")).toBe(false);
  });
});

describe("daemon worker API delivers photo/file", () => {
  test("worker API sendPhoto/sendDocument hit Telegram for live session", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "acpbot-tg-media-"));
    const repoDir = join(stateDir, "repo");
    await mkdir(repoDir, { recursive: true });
    const shot = join(repoDir, "shot.png");
    await writeFile(shot, "PNG-FAKE-BYTES");
    const sockPath = join(stateDir, "worker-api.sock");

    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: repoDir },
      },
    });
    const daemon = createDaemon(env, { stateDir: stateDir });
    await daemon.handleUpdate(root("/new demo mediaout", 1));
    const session = (await daemon.listSessions())[0]!;

    const { createWorkerApiServer } = await import(
      "../src/core/worker-api-server"
    );
    const { readFile } = await import("node:fs/promises");
    const server = createWorkerApiServer({
      sockPath,
      handlers: {
        async sendMessage() {
          throw new Error("unused");
        },
        async sendPhoto({ sessionKey, path, caption, filename }) {
          const s = (await daemon.listSessions()).find(
            (x) => x.sessionKey === sessionKey,
          );
          if (!s) throw new Error(`unknown sessionKey: ${sessionKey}`);
          const data = new Uint8Array(await readFile(path));
          await env.telegram.sendPhoto!({
            chatId: s.chatId,
            messageThreadId: s.messageThreadId,
            data,
            filename: filename ?? "photo.jpg",
            ...(caption ? { caption } : {}),
          });
          return { bytes: data.byteLength };
        },
        async sendDocument({ sessionKey, path, caption, filename }) {
          const s = (await daemon.listSessions()).find(
            (x) => x.sessionKey === sessionKey,
          );
          if (!s) throw new Error(`unknown sessionKey: ${sessionKey}`);
          const data = new Uint8Array(await readFile(path));
          await env.telegram.sendDocument!({
            chatId: s.chatId,
            messageThreadId: s.messageThreadId,
            data,
            filename: filename ?? "file",
            ...(caption ? { caption } : {}),
          });
          return { bytes: data.byteLength };
        },
        async speak() {
          throw new Error("unused");
        },
      },
    });
    await server.listen();
    try {
      const { workerSendDocument, workerSendPhoto } = await import(
        "../src/mcp/worker-api"
      );
      const photo = await workerSendPhoto(
        {
          sessionKey: session.sessionKey,
          path: shot,
          caption: "preview",
          filename: "shot.png",
        },
        { sockPath },
      );
      expect(photo.ok).toBe(true);

      const photos = env.telegram.outbound.filter(
        (c) => c.method === "sendPhoto",
      );
      expect(photos.length).toBeGreaterThanOrEqual(1);
      const last = photos[photos.length - 1]!;
      if (last.method === "sendPhoto") {
        expect(new TextDecoder().decode(last.params.data)).toBe(
          "PNG-FAKE-BYTES",
        );
        expect(last.params.caption).toBe("preview");
        expect(last.params.filename).toBe("shot.png");
        expect(last.params.messageThreadId).toBe(session.messageThreadId);
      }

      const doc = await workerSendDocument(
        {
          sessionKey: session.sessionKey,
          path: shot,
          filename: "report.bin",
          caption: "log",
        },
        { sockPath },
      );
      expect(doc.ok).toBe(true);
      const docs = env.telegram.outbound.filter(
        (c) => c.method === "sendDocument",
      );
      expect(docs.length).toBeGreaterThanOrEqual(1);
      const lastDoc = docs[docs.length - 1]!;
      if (lastDoc.method === "sendDocument") {
        expect(lastDoc.params.filename).toBe("report.bin");
        expect(lastDoc.params.caption).toBe("log");
      }
    } finally {
      await server.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
