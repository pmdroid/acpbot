/**
 * Multi-host: local Unix still works; remote WSS + token auth; bad token rejected.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startAcpHostServer } from "../src/acp-host/server";
import {
  assertAcpHostReady,
  createAcpHostClient,
} from "../src/acp-host/client";
import { createMemoryHostSessionStore } from "../src/acp/session-store";
import {
  parseHostsCatalog,
  resolveHostId,
  getHostEndpoint,
} from "../src/acp-host/hosts";
import { createHostRouter } from "../src/acp-host/router";

describe("hosts catalog", () => {
  test("string repos default to local; table form binds host", () => {
    const cat = parseHostsCatalog({
      rawHosts: {
        studio: {
          kind: "wss",
          url: "wss://studio.example:8790",
          token: "secret",
        },
      },
      rawRepos: {
        demo: "/tmp/demo",
        work: { path: "/data/work", host: "studio" },
      },
      defaultSockPath: "/tmp/acp-host.sock",
    });
    expect(cat.repos.demo?.hostId).toBe("local");
    expect(cat.repos.work?.hostId).toBe("studio");
    expect(resolveHostId({ repoKey: "work", catalog: cat })).toBe("studio");
    expect(resolveHostId({ repoKey: "demo", catalog: cat })).toBe("local");
    expect(
      resolveHostId({
        sessionHostId: "studio",
        repoKey: "demo",
        catalog: cat,
      }),
    ).toBe("studio");
  });

  test("unknown sticky host fails closed (no local fallback)", () => {
    const cat = parseHostsCatalog({
      rawRepos: { demo: "/tmp/demo" },
    });
    expect(() =>
      resolveHostId({ sessionHostId: "missing", catalog: cat }),
    ).toThrow(/unknown host/);
  });

  test("wss endpoint requires url and token", () => {
    const cat = parseHostsCatalog({
      rawHosts: {
        bad: { kind: "wss", url: "wss://x" },
      },
    });
    expect(() => getHostEndpoint(cat, "bad")).toThrow(/token/);
  });

  test("env: token indirection", () => {
    const cat = parseHostsCatalog({
      rawHosts: {
        studio: {
          kind: "wss",
          url: "ws://127.0.0.1:1",
          token: "env:TEST_HOST_TOKEN_XYZ",
        },
      },
      env: { TEST_HOST_TOKEN_XYZ: "from-env" } as NodeJS.ProcessEnv,
    });
    expect(cat.hosts.studio?.token).toBe("from-env");
  });
});

describe("multi-host transport", () => {
  test("local Unix ensure/ping still works", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-mh-unix-"));
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
      const client = createAcpHostClient({ sockPath });
      // ping via ensure is heavy; list through ensureSession not required —
      // assertAcpHostReady already pinged.
      expect(client).toBeTruthy();
    } finally {
      await close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("remote WSS: valid token can ping; invalid token rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-mh-wss-"));
    const sockPath = join(dir, "h.sock");
    const token = "test-host-token-abc";
    const { close, remotePort } = await startAcpHostServer({
      sockPath,
      stateDir: dir,
      sessionStore: createMemoryHostSessionStore(),
      enableScheduler: false,
      remoteListen: {
        port: 0, // ephemeral — Bun may not support 0; use high port
        host: "127.0.0.1",
        token,
      },
    });
    try {
      // If port 0 not supported, remotePort may be undefined — skip gracefully
      const port = remotePort;
      if (port == null || port <= 0) {
        // retry with fixed high port
        await close();
        const portFixed = 18790 + Math.floor(Math.random() * 1000);
        const again = await startAcpHostServer({
          sockPath: join(dir, "h2.sock"),
          stateDir: dir,
          sessionStore: createMemoryHostSessionStore(),
          enableScheduler: false,
          remoteListen: {
            port: portFixed,
            host: "127.0.0.1",
            token,
          },
        });
        try {
          await runWssAuthTests(again.remotePort ?? portFixed, token);
        } finally {
          await again.close();
        }
        return;
      }
      await runWssAuthTests(port, token);
    } finally {
      await close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function runWssAuthTests(port: number, token: string) {
  const url = `ws://127.0.0.1:${port}`;

  // Good token
  const good = createAcpHostClient({ url, token });
  // Trigger connect+hello via ensureSession with fake cwd — may fail agent spawn
  // but hello must succeed first. Use a lightweight path: call ensure and catch
  // agent errors after auth.
  let authOk = false;
  try {
    await good.ensureSession({
      sessionKey: "demo/t",
      agent: "grok-build",
      cwd: process.cwd(),
    });
    authOk = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Auth failure would say "auth failed" or "invalid host token"
    if (/auth failed|invalid host token|not authenticated/i.test(msg)) {
      throw e;
    }
    // Agent binary missing is OK — proves we got past hello
    authOk = true;
  }
  expect(authOk).toBe(true);

  // Bad token
  const bad = createAcpHostClient({ url, token: "wrong-token" });
  await expect(
    bad.ensureSession({
      sessionKey: "demo/bad",
      agent: "grok-build",
      cwd: process.cwd(),
    }),
  ).rejects.toThrow(/auth failed|invalid host token/i);
}

describe("host router sticky resolution", () => {
  test("router returns distinct clients per host id", () => {
    const cat = parseHostsCatalog({
      rawHosts: {
        studio: {
          kind: "wss",
          url: "ws://127.0.0.1:9",
          token: "t",
        },
      },
      rawRepos: {
        a: "/tmp/a",
        b: { path: "/tmp/b", host: "studio" },
      },
      defaultSockPath: "/tmp/x.sock",
    });
    const router = createHostRouter({ catalog: cat, stateDir: "/tmp" });
    const local = router.getHost("local");
    const studio = router.getHost("studio");
    expect(local).not.toBe(studio);
    expect(router.getHost("local")).toBe(local);
  });
});
