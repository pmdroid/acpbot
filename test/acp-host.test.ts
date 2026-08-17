import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { defaultAcpHostSock } from "../src/acp-host/protocol";
import { startAcpHostServer } from "../src/acp-host/server";
import {
  AcpHostRequiredError,
  assertAcpHostReady,
  createAcpHostClient,
  resolveAcpHostSockPath,
} from "../src/acp-host/client";
import { createMemoryHostSessionStore } from "../src/acp/session-store";
import type { SessionHost } from "../src/acp/session-host";

describe("acp-host protocol helpers", () => {
  test("default sock under state dir", () => {
    expect(defaultAcpHostSock("/tmp/x")).toBe("/tmp/x/acp-host.sock");
    expect(resolveAcpHostSockPath("/tmp/x", {})).toBe("/tmp/x/acp-host.sock");
  });

  test("assertAcpHostReady fails when socket missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-host-miss-"));
    try {
      await expect(
        assertAcpHostReady({ stateDir: dir, timeoutMs: 500 }),
      ).rejects.toBeInstanceOf(AcpHostRequiredError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("assertAcpHostReady pings a live host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-host-ready-"));
    const sockPath = join(dir, "h.sock");
    const { close } = await startAcpHostServer({
      sockPath,
      stateDir: dir,
      sessionStore: createMemoryHostSessionStore(),
      enableScheduler: false,
    });
    try {
      const r = await assertAcpHostReady({ sockPath, timeoutMs: 2000 });
      expect(r.sockPath).toBe(sockPath);
    } finally {
      await close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("acp-host server", () => {
  test("ping / list over unix socket; slots survive client disconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-host-"));
    const sockPath = join(dir, "h.sock");
    const { close } = await startAcpHostServer({
      sockPath,
      stateDir: dir,
      sessionStore: createMemoryHostSessionStore(),
      enableScheduler: false,
    });

    const reply = await new Promise<string>((resolve, reject) => {
      const s = createConnection(sockPath);
      let buf = "";
      s.setEncoding("utf8");
      s.on("connect", () => {
        s.write(
          JSON.stringify({ type: "ping", reqId: "1" }) +
            "\n" +
            JSON.stringify({ type: "list", reqId: "2" }) +
            "\n",
        );
      });
      s.on("data", (c) => {
        buf += c;
        if (buf.includes("list_ok")) {
          s.end();
          resolve(buf);
        }
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(reply).toContain("pong");
    expect(reply).toContain("list_ok");
    expect(reply).toContain('"slots":[]');

    await close();
    await rm(dir, { recursive: true, force: true });
  });

  test("client detach does not require live agent for dispose", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-host-"));
    const sockPath = join(dir, "h.sock");
    const { close } = await startAcpHostServer({
      sockPath,
      stateDir: dir,
      sessionStore: createMemoryHostSessionStore(),
      enableScheduler: false,
    });

    const client: SessionHost = createAcpHostClient({ sockPath });
    // dispose without ensure — should not throw hard
    await client.dispose();
    await close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("acp-host computer protocol", () => {
  test("grant/abort + stub probe; frame_ack has no reqId and does not hang", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-host-comp-"));
    const sockPath = join(dir, "h.sock");
    const { close } = await startAcpHostServer({
      sockPath,
      stateDir: dir,
      sessionStore: createMemoryHostSessionStore(),
      enableScheduler: false,
    });
    const frames: unknown[] = [];
    const statuses: unknown[] = [];
    const client = createAcpHostClient({
      sockPath,
      onComputerFrame: (m) => {
        frames.push(m);
      },
      onComputerStatus: (m) => {
        statuses.push(m);
      },
    });
    try {
      const ok = await client.computerGrant({
        slotKey: "demo/box",
        grant: {
          enabled: true,
          watch: false,
          expiresAt: Date.now() + 60_000,
          hostId: "local",
        },
      });
      expect(ok.probe).toEqual({
        ok: false,
        backend: "fake",
        missing: ["backend"],
        inputEnabled: false,
        display: { id: "0", width: 0, height: 0, scale: 1 },
      });

      const t0 = Date.now();
      client.computerFrameAck("demo/box", "frame-1");
      expect(Date.now() - t0).toBeLessThan(500);

      await client.computerAbort("demo/box");
    } finally {
      await client.dispose();
      await close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("old host unknown type; frame_ack wire has no reqId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-host-old-"));
    const sockPath = join(dir, "old.sock");
    const received: Array<Record<string, unknown>> = [];
    const { createServer } = await import("node:net");
    const server = createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as Record<string, unknown>;
          received.push(msg);
          if (msg.type === "ping") {
            sock.write(
              JSON.stringify({ type: "pong", reqId: msg.reqId }) + "\n",
            );
          } else if (msg.type === "computer_grant") {
            sock.write(
              JSON.stringify({
                type: "err",
                reqId: msg.reqId,
                error: "unknown type",
              }) + "\n",
            );
          } else if (msg.type === "computer_abort") {
            sock.write(
              JSON.stringify({
                type: "err",
                reqId: msg.reqId,
                error: "unknown type",
              }) + "\n",
            );
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(sockPath, () => resolve());
      server.on("error", reject);
    });
    const client = createAcpHostClient({ sockPath });
    try {
      await expect(
        client.computerGrant({
          slotKey: "demo/old",
          grant: {
            enabled: true,
            watch: false,
            expiresAt: 0,
            hostId: "local",
          },
        }),
      ).rejects.toThrow(/unknown type/);

      // Connect via a second grant attempt already connected; send ack.
      client.computerFrameAck("demo/old", "f-ack");
      await new Promise((r) => setTimeout(r, 50));
      const ack = received.find((m) => m.type === "computer_frame_ack");
      expect(ack).toBeDefined();
      expect(ack).toEqual({
        type: "computer_frame_ack",
        slotKey: "demo/old",
        frameId: "f-ack",
      });
      expect("reqId" in (ack ?? {})).toBe(false);
    } finally {
      await client.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("computer_frame goes to onComputerFrame, not pending/eve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-host-frame-"));
    const sockPath = join(dir, "f.sock");
    const { createServer } = await import("node:net");
    let sock: import("node:net").Socket | undefined;
    const server = createServer((s) => {
      sock = s;
      s.setEncoding("utf8");
      let buf = "";
      s.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as { type?: string; reqId?: string };
          if (msg.type === "computer_grant") {
            s.write(
              JSON.stringify({
                type: "computer_grant_ok",
                reqId: msg.reqId,
                slotKey: "demo/f",
                probe: {
                  ok: false,
                  backend: "fake",
                  missing: ["backend"],
                  inputEnabled: false,
                  display: { id: "0", width: 0, height: 0, scale: 1 },
                },
              }) + "\n",
            );
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(sockPath, () => resolve());
      server.on("error", reject);
    });

    const frames: string[] = [];
    const eve: string[] = [];
    const client = createAcpHostClient({
      sockPath,
      onComputerFrame: (m) => {
        frames.push(m.frameId);
      },
      onEveNotify: (m) => {
        eve.push(m.text);
      },
    });
    try {
      await client.computerGrant({
        slotKey: "demo/f",
        grant: {
          enabled: true,
          watch: false,
          expiresAt: 0,
          hostId: "local",
        },
      });
      expect(sock).toBeDefined();
      sock!.write(
        JSON.stringify({
          type: "computer_frame",
          sessionKey: "demo/f",
          jpegBase64: "AA==",
          caption: "cap",
          width: 1,
          height: 1,
          frameId: "frame-1",
          hostId: "local",
        }) + "\n",
      );
      sock!.write(
        JSON.stringify({
          type: "future_unsolicited",
          sessionKey: "demo/f",
        }) + "\n",
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(frames).toEqual(["frame-1"]);
      expect(eve).toEqual([]);
    } finally {
      await client.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("daemon eveHost path does not register onComputerFrame", async () => {
    const src = await Bun.file("src/core/daemon.ts").text();
    const start = src.indexOf("const eveHost = createAcpHostClient");
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, start + 900);
    expect(block).toContain("onEveNotify");
    expect(block).not.toContain("onComputerFrame");
    expect(src).toContain("setComputerFrameHandler");
  });
});
