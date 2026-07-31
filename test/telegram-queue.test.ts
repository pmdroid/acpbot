import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { TelegramUpdate } from "../src/env/types";
import {
  completeTelegramJob,
  enqueueTelegramJob,
  listPendingTelegramJobs,
  telegramQueueDir,
  waitForTelegramAck,
} from "../src/mcp/telegram-queue";
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

describe("telegram-queue", () => {
  test("enqueue + list + complete ack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-q-"));
    const queueDir = telegramQueueDir(dir);
    const job = await enqueueTelegramJob({
      sessionKey: "demo/a",
      text: "halfway done",
      kind: "update",
      queueDir,
    });
    const pending = await listPendingTelegramJobs(queueDir);
    expect(pending.some((j) => j.id === job.id)).toBe(true);
    expect(pending.find((j) => j.id === job.id)?.kind).toBe("update");

    const wait = waitForTelegramAck(job.id, { queueDir, timeoutMs: 2000 });
    await completeTelegramJob(job, { ok: true }, queueDir);
    const ack = await wait;
    expect(ack.ok).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test("photo/document jobs require path and list correctly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-q-media-"));
    const queueDir = telegramQueueDir(dir);
    const photo = await enqueueTelegramJob({
      sessionKey: "demo/a",
      kind: "photo",
      path: "/tmp/shot.png",
      filename: "shot.png",
      text: "caption",
      queueDir,
    });
    const doc = await enqueueTelegramJob({
      sessionKey: "demo/a",
      kind: "document",
      path: "/tmp/out.log",
      filename: "out.log",
      queueDir,
    });
    const pending = await listPendingTelegramJobs(queueDir);
    expect(pending.find((j) => j.id === photo.id)?.kind).toBe("photo");
    expect(pending.find((j) => j.id === photo.id)?.path).toBe("/tmp/shot.png");
    expect(pending.find((j) => j.id === doc.id)?.kind).toBe("document");

    await expect(
      enqueueTelegramJob({
        sessionKey: "demo/a",
        kind: "photo",
        queueDir,
      }),
    ).rejects.toThrow(/path/);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("repo-path", () => {
  test("resolves relative path under repo and rejects escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-"));
    await mkdir(join(root, "out"), { recursive: true });
    const file = join(root, "out", "a.png");
    await writeFile(file, "png-bytes");

    const ok = resolvePathUnderRepo(root, "out/a.png");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.size).toBe(9);
      expect(ok.rel.replace(/\\/g, "/")).toBe("out/a.png");
    }

    const escape = resolvePathUnderRepo(root, "../secret");
    expect(escape.ok).toBe(false);

    const missing = resolvePathUnderRepo(root, "nope.bin");
    expect(missing.ok).toBe(false);

    expect(basenameOf("/a/b/c.txt")).toBe("c.txt");
    expect(TELEGRAM_PHOTO_MAX_BYTES).toBeGreaterThan(1_000_000);

    await rm(root, { recursive: true, force: true });
  });
});

describe("telegram tool name detection", () => {
  test("matches update / telegram_send prefixes", () => {
    expect(isTelegramUpdateToolName("update")).toBe(true);
    expect(isTelegramUpdateToolName("mcp__tacp__update")).toBe(true);
    expect(isTelegramUpdateToolName("tacp:update")).toBe(true);
    expect(isTelegramUpdateToolName("progress")).toBe(true);
    expect(isTelegramMessageToolName("telegram_send")).toBe(true);
    expect(isTelegramMessageToolName("mcp__tacp__telegram_send")).toBe(true);
    expect(isTelegramTextToolName("speak")).toBe(false);
    expect(telegramTextFromToolInput({ text: " hi " })).toBe("hi");
  });

  test("matches photo and file tool names", () => {
    expect(isTelegramPhotoToolName("telegram_send_photo")).toBe(true);
    expect(isTelegramPhotoToolName("mcp__tacp__telegram_send_photo")).toBe(
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
    const stateDir = await mkdtemp(join(tmpdir(), "tacp-tg-media-"));
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
    // Drive daemon session map via handleUpdate, then exercise worker handlers
    // the same way createDaemon wires them (session lookup + sendPhoto).
    const daemon = createDaemon(env, { acpxStateDir: stateDir });
    await daemon.handleUpdate(root("/new demo mediaout", 1));
    const session = (await daemon.listSessions())[0]!;

    // Inline server with the same delivery path as the daemon handlers.
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
      const {
        workerSendDocument,
        workerSendPhoto,
      } = await import("../src/mcp/worker-api");
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
