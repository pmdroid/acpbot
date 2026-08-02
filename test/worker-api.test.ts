import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerApiServer } from "../src/core/worker-api-server";
import {
  workerApiSockPath,
  workerHealth,
  workerSendDocument,
  workerSendMessage,
  workerSendPhoto,
  workerSpeak,
} from "../src/mcp/worker-api";
import { buildAcpbotMcpServers } from "../src/mcp/servers";

describe("worker API", () => {
  test("sock path defaults under state dir", () => {
    expect(workerApiSockPath("/tmp/state")).toBe(
      "/tmp/state/worker-api.sock",
    );
  });

  test("buildAcpbotMcpServers injects ACPBOT_WORKER_API_SOCK", () => {
    const servers = buildAcpbotMcpServers({
      enabled: true,
      sessionKey: "demo/a",
      stateDir: "/tmp/acpbot-state",
    });
    const env = Object.fromEntries(
      (servers[0]?.env ?? []).map((e) => [e.name, e.value]),
    );
    expect(env.ACPBOT_SESSION_KEY).toBe("demo/a");
    expect(env.ACPBOT_WORKER_API_SOCK).toBe("/tmp/acpbot-state/worker-api.sock");
    expect(env.ACPBOT_STATE_DIR).toBe("/tmp/acpbot-state");
  });

  test("message/photo/document/speak over unix socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "worker-api-"));
    const sockPath = join(dir, "worker-api.sock");
    const calls: Array<{ kind: string; body: unknown }> = [];
    const photoPath = join(dir, "shot.png");
    await writeFile(photoPath, "PNGDATA");

    const server = createWorkerApiServer({
      sockPath,
      handlers: {
        async sendMessage(input) {
          calls.push({ kind: "message", body: input });
          return { message: `ok message ${input.kind}` };
        },
        async sendPhoto(input) {
          calls.push({ kind: "photo", body: input });
          return { message: "ok photo", bytes: 7 };
        },
        async sendDocument(input) {
          calls.push({ kind: "document", body: input });
          return { message: "ok doc", bytes: 7 };
        },
        async speak(input) {
          calls.push({ kind: "speak", body: input });
          return { message: "ok speak" };
        },
      },
    });

    await server.listen();
    try {
      const health = await workerHealth({ sockPath });
      expect(health.ok).toBe(true);

      const msg = await workerSendMessage(
        {
          sessionKey: "demo/t",
          text: "hello",
          kind: "update",
        },
        { sockPath },
      );
      expect(msg.ok).toBe(true);
      if (msg.ok) expect(msg.message).toContain("update");

      const photo = await workerSendPhoto(
        {
          sessionKey: "demo/t",
          path: photoPath,
          caption: "cap",
        },
        { sockPath },
      );
      expect(photo.ok).toBe(true);

      const doc = await workerSendDocument(
        {
          sessionKey: "demo/t",
          path: photoPath,
          filename: "a.bin",
        },
        { sockPath },
      );
      expect(doc.ok).toBe(true);

      const speak = await workerSpeak(
        { sessionKey: "demo/t", text: "hi voice" },
        { sockPath },
      );
      expect(speak.ok).toBe(true);

      expect(calls.map((c) => c.kind)).toEqual([
        "message",
        "photo",
        "document",
        "speak",
      ]);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unknown session surfaces error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "worker-api-err-"));
    const sockPath = join(dir, "worker-api.sock");
    const server = createWorkerApiServer({
      sockPath,
      handlers: {
        async sendMessage() {
          throw new Error("unknown sessionKey: nope");
        },
        async sendPhoto() {
          throw new Error("unused");
        },
        async sendDocument() {
          throw new Error("unused");
        },
        async speak() {
          throw new Error("unused");
        },
      },
    });
    await server.listen();
    try {
      const r = await workerSendMessage(
        { sessionKey: "nope", text: "x", kind: "message" },
        { sockPath },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("unknown sessionKey");
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
