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
      expect(ok.probe.backend).toBe("fake");
      expect(ok.probe.inputEnabled).toBe(false);
      expect(ok.probe.ok).toBe(true);

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

  test("granted slot + fireScheduledPrompt → bad_source; next operator prompt works", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-host-src-"));
    const sockPath = join(dir, "h.sock");
    let releaseSchedule: (() => void) | undefined;
    const scheduleHold = new Promise<void>((r) => {
      releaseSchedule = r;
    });
    let turns = 0;
    const fakeHost: SessionHost = {
      ensureSession: async (input) => ({
        sessionKey: input.sessionKey,
        agentSessionId: "s1",
        cwd: input.cwd,
        agent: input.agent,
      }),
      startTurn: () => {
        turns += 1;
        const hold = turns === 1 ? scheduleHold : Promise.resolve();
        return {
          events: (async function* () {
            await hold;
            yield { type: "done" as const, stopReason: "end_turn" };
          })(),
          result: hold.then(() => ({ status: "ok" })),
          cancel: async () => {},
        };
      },
      cancel: async () => {},
      setMode: async () => ({ currentModeId: undefined, availableModeIds: [] }),
      getModeState: async () => ({
        currentModeId: undefined,
        availableModeIds: [],
      }),
      getAvailableModes: async () => [],
      getConfigOptions: async () => [],
      setConfigOption: async () => [],
      disposeSession: async () => {},
      setHooks: () => {},
      dispose: async () => {},
    };
    const host = await startAcpHostServer({
      sockPath,
      stateDir: dir,
      sessionStore: createMemoryHostSessionStore(),
      enableScheduler: false,
      testSessionHost: fakeHost,
      config: {
        operatorUserId: 0,
        computer: { enabled: true, minActionIntervalMs: 0 },
      },
    });
    const client = createAcpHostClient({ sockPath });
    try {
      await client.ensureSession({
        sessionKey: "demo/box",
        agent: "test",
        cwd: dir,
        computerAllowed: true,
      });
      await client.computerGrant({
        slotKey: "demo/box",
        grant: {
          enabled: true,
          watch: false,
          expiresAt: 0,
          hostId: "local",
        },
      });

      const fireP = host.fireScheduledPrompt({
        sessionKey: "demo/box",
        repoRoot: dir,
        text: "cron tick",
      });
      await Bun.sleep(30);
      const scheduled = await host.computerAct("demo/box", { type: "screenshot" });
      expect(scheduled.ok).toBe(false);
      if (!scheduled.ok) expect(scheduled.error).toBe("bad_source");
      releaseSchedule?.();
      await fireP;

      host.setTurnSource("demo/box", "operator");
      const operator = await host.computerAct("demo/box", { type: "screenshot" });
      expect(operator.ok).toBe(true);
      if (operator.ok) {
        expect(operator.frameId).toBeTruthy();
        expect(operator.jpeg).toBeDefined();
      }
    } finally {
      await client.dispose();
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("ensureSlotForSchedule does not flip computerAllowed on a live operator slot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-host-keep-"));
    const sockPath = join(dir, "h.sock");
    const fakeHost: SessionHost = {
      ensureSession: async (input) => ({
        sessionKey: input.sessionKey,
        agentSessionId: "s1",
        cwd: input.cwd,
        agent: input.agent,
      }),
      startTurn: () => ({
        events: (async function* () {
          yield { type: "done" as const, stopReason: "end_turn" };
        })(),
        result: Promise.resolve({ status: "ok" }),
        cancel: async () => {},
      }),
      cancel: async () => {},
      setMode: async () => ({ currentModeId: undefined, availableModeIds: [] }),
      getModeState: async () => ({
        currentModeId: undefined,
        availableModeIds: [],
      }),
      getAvailableModes: async () => [],
      getConfigOptions: async () => [],
      setConfigOption: async () => [],
      disposeSession: async () => {},
      setHooks: () => {},
      dispose: async () => {},
    };
    const host = await startAcpHostServer({
      sockPath,
      stateDir: dir,
      sessionStore: createMemoryHostSessionStore(),
      enableScheduler: false,
      testSessionHost: fakeHost,
      config: {
        operatorUserId: 0,
        computer: { enabled: true, minActionIntervalMs: 0 },
      },
    });
    const client = createAcpHostClient({ sockPath });
    try {
      await client.ensureSession({
        sessionKey: "demo/keep",
        agent: "test",
        cwd: dir,
        computerAllowed: true,
      });
      await client.computerGrant({
        slotKey: "demo/keep",
        grant: { enabled: true, watch: false, expiresAt: 0, hostId: "local" },
      });
      await host.fireScheduledPrompt({
        sessionKey: "demo/keep",
        repoRoot: dir,
        text: "tick",
      });
      host.setTurnSource("demo/keep", "operator");
      const shot = await host.computerAct("demo/keep", { type: "screenshot" });
      expect(shot.ok).toBe(true);
    } finally {
      await client.dispose();
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("bypass operator slot + cron keeps computerAllowed, grant, token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-host-bypass-"));
    const sockPath = join(dir, "h.sock");
    let releaseSchedule: (() => void) | undefined;
    const scheduleHold = new Promise<void>((r) => {
      releaseSchedule = r;
    });
    let ensureCalls = 0;
    const fakeHost: SessionHost = {
      ensureSession: async (input) => {
        ensureCalls += 1;
        return {
          sessionKey: input.sessionKey,
          agentSessionId: "s1",
          cwd: input.cwd,
          agent: input.agent,
        };
      },
      startTurn: () => ({
        events: (async function* () {
          await scheduleHold;
          yield { type: "done" as const, stopReason: "end_turn" };
        })(),
        result: scheduleHold.then(() => ({ status: "ok" })),
        cancel: async () => {},
      }),
      cancel: async () => {},
      setMode: async () => ({ currentModeId: undefined, availableModeIds: [] }),
      getModeState: async () => ({
        currentModeId: undefined,
        availableModeIds: [],
      }),
      getAvailableModes: async () => [],
      getConfigOptions: async () => [],
      setConfigOption: async () => [],
      disposeSession: async () => {},
      setHooks: () => {},
      dispose: async () => {},
    };
    const host = await startAcpHostServer({
      sockPath,
      stateDir: dir,
      sessionStore: createMemoryHostSessionStore(),
      enableScheduler: false,
      testSessionHost: fakeHost,
      config: {
        operatorUserId: 0,
        permissionMode: "ask",
        computer: { enabled: true, minActionIntervalMs: 0 },
      },
    });
    const client = createAcpHostClient({ sockPath });
    try {
      await client.ensureSession({
        sessionKey: "demo/bypass",
        agent: "test",
        cwd: dir,
        permissionMode: "bypass",
        computerAllowed: true,
      });
      await client.computerGrant({
        slotKey: "demo/bypass",
        grant: { enabled: true, watch: false, expiresAt: 0, hostId: "local" },
      });
      const before = host.inspectSlot("demo/bypass");
      expect(before?.computerAllowed).toBe(true);
      expect(before?.permissionMode).toBe("bypass");
      expect(before?.hostApiToken).toBeTruthy();
      const token = before!.hostApiToken;

      const fireP = host.fireScheduledPrompt({
        sessionKey: "demo/bypass",
        repoRoot: dir,
        text: "cron tick",
      });
      await Bun.sleep(30);
      const during = host.inspectSlot("demo/bypass");
      expect(during?.computerAllowed).toBe(true);
      expect(during?.permissionMode).toBe("bypass");
      expect(during?.hostApiToken).toBe(token);
      const scheduled = await host.computerAct("demo/bypass", {
        type: "screenshot",
      });
      expect(scheduled.ok).toBe(false);
      if (!scheduled.ok) expect(scheduled.error).toBe("bad_source");
      releaseSchedule?.();
      await fireP;

      host.setTurnSource("demo/bypass", "operator");
      const operator = await host.computerAct("demo/bypass", {
        type: "screenshot",
      });
      expect(operator.ok).toBe(true);
      expect(host.inspectSlot("demo/bypass")?.hostApiToken).toBe(token);
      expect(ensureCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await client.dispose();
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("host-api token: Bearer required, sessionKey is not auth, reuse/rotate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-host-tok-"));
    const sockPath = join(dir, "h.sock");
    const fakeHost: SessionHost = {
      ensureSession: async (input) => ({
        sessionKey: input.sessionKey,
        agentSessionId: "s1",
        cwd: input.cwd,
        agent: input.agent,
      }),
      startTurn: () => ({
        events: (async function* () {
          yield { type: "done" as const, stopReason: "end_turn" };
        })(),
        result: Promise.resolve({ status: "ok" }),
        cancel: async () => {},
      }),
      cancel: async () => {},
      setMode: async () => ({ currentModeId: undefined, availableModeIds: [] }),
      getModeState: async () => ({
        currentModeId: undefined,
        availableModeIds: [],
      }),
      getAvailableModes: async () => [],
      getConfigOptions: async () => [],
      setConfigOption: async () => [],
      disposeSession: async () => {},
      setHooks: () => {},
      dispose: async () => {},
    };
    const host = await startAcpHostServer({
      sockPath,
      stateDir: dir,
      sessionStore: createMemoryHostSessionStore(),
      enableScheduler: false,
      testSessionHost: fakeHost,
      config: {
        operatorUserId: 0,
        computer: { enabled: true, minActionIntervalMs: 0 },
      },
    });
    const client = createAcpHostClient({ sockPath });
    const { hostComputerStatus, hostApiRequest } = await import(
      "../src/mcp/host-api"
    );
    try {
      await client.ensureSession({
        sessionKey: "demo/tok",
        agent: "test",
        cwd: dir,
        computerAllowed: true,
      });
      const minted = host.inspectSlot("demo/tok")?.hostApiToken;
      expect(minted).toBeTruthy();
      expect(minted).not.toBe("demo/tok");

      const noBearer = await hostComputerStatus("demo/tok", {
        sockPath: host.hostApiSockPath,
        token: "",
      });
      expect(noBearer.ok).toBe(false);
      if (!noBearer.ok) expect(noBearer.error).toMatch(/unauthorized/i);

      const sessionAsSecret = await hostComputerStatus("demo/tok", {
        sockPath: host.hostApiSockPath,
        token: "demo/tok",
      });
      expect(sessionAsSecret.ok).toBe(false);
      if (!sessionAsSecret.ok) expect(sessionAsSecret.error).toMatch(/unauthorized/i);

      const ok = await hostComputerStatus("demo/tok", {
        sockPath: host.hostApiSockPath,
        token: minted,
      });
      expect(ok.ok).toBe(true);

      await client.ensureSession({
        sessionKey: "demo/tok",
        agent: "test",
        cwd: dir,
        computerAllowed: true,
      });
      expect(host.inspectSlot("demo/tok")?.hostApiToken).toBe(minted);

      await client.ensureSession({
        sessionKey: "demo/tok",
        agent: "test",
        cwd: dir,
        computerAllowed: true,
        forceNewSession: true,
      });
      const rotated = host.inspectSlot("demo/tok")?.hostApiToken;
      expect(rotated).toBeTruthy();
      expect(rotated).not.toBe(minted);

      const clientSrc = await Bun.file("src/acp-host/client.ts").text();
      const protoSrc = await Bun.file("src/acp-host/protocol.ts").text();
      const mcpSrc = await Bun.file("src/mcp/host-api.ts").text();
      expect(protoSrc).not.toMatch(/hostApiToken\s*\?:/);
      expect(clientSrc).not.toContain("hostApiToken");
      expect(mcpSrc).toContain("authorization");
      expect(mcpSrc).toContain("Bearer");
      expect(mcpSrc).not.toMatch(/searchParams.*token|token=.*sessionKey|query.*TOKEN/i);

      const get = await hostApiRequest(
        `/v1/computer/status?sessionKey=demo/tok`,
        undefined,
        {
          sockPath: host.hostApiSockPath,
          token: rotated,
          method: "GET",
        },
      );
      expect(get.ok).toBe(true);
    } finally {
      await client.dispose();
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
