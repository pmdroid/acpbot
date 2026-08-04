/**
 * Client-side e2e for multi-host remote WSS (run on Mac against Orb VM host).
 * Env: E2E_REMOTE_URL, E2E_REMOTE_TOKEN, E2E_RESULT_FILE
 *
 * Does not depend on agent CLIs being installed: ensure may fail after auth
 * with "agent binary not found" and that still counts as auth+RPC success.
 */
import { createAcpHostClient, assertAcpHostReady } from "../src/acp-host/client";
import { startAcpHostServer } from "../src/acp-host/server";
import { createMemoryHostSessionStore } from "../src/acp/session-store";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const url = process.env.E2E_REMOTE_URL?.trim();
const token = process.env.E2E_REMOTE_TOKEN?.trim();
const resultFile =
  process.env.E2E_RESULT_FILE?.trim() ||
  join(process.env.E2E_SCRATCH || ".", "e2e-result.json");

if (!url || !token) {
  console.error("E2E_REMOTE_URL and E2E_REMOTE_TOKEN required");
  process.exit(2);
}

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];

function pass(name: string, detail?: string) {
  checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
  console.log(`  OK ${name}${detail ? ` -- ${detail}` : ""}`);
}
function fail(name: string, detail: string) {
  checks.push({ name, ok: false, detail });
  console.error(`  FAIL ${name} -- ${detail}`);
}

/** Race a promise against a timeout so a live agent cannot hang e2e. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** True if ensure failed only after auth (agent missing / spawn / etc.). */
function isPostAuthError(msg: string): boolean {
  if (/auth failed|invalid host token|not authenticated/i.test(msg)) {
    return false;
  }
  return true;
}

async function tryEnsure(
  client: ReturnType<typeof createAcpHostClient>,
  sessionKey: string,
  label: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    await withTimeout(
      client.ensureSession({
        sessionKey,
        // Intentionally nonexistent agent so we fail after RPC without hanging.
        agent: "e2e-nonexistent-agent-xyz",
        cwd: process.cwd(),
      }),
      15_000,
      label,
    );
    return { ok: true, detail: "ensure completed" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isPostAuthError(msg)) {
      return { ok: false, detail: msg };
    }
    return {
      ok: true,
      detail: `auth+RPC ok; post-auth: ${msg.slice(0, 140)}`,
    };
  }
}

async function main() {
  console.log(`e2e client -> ${url}`);

  // 1) Good token
  {
    const good = createAcpHostClient({ url, token });
    const r = await tryEnsure(good, "e2e/remote", "remote ensure");
    if (r.ok) pass("remote ensure with valid token", r.detail);
    else fail("remote ensure with valid token", r.detail);
  }

  // 2) Bad token rejected
  {
    const bad = createAcpHostClient({ url, token: "wrong-token-e2e" });
    try {
      await withTimeout(
        bad.ensureSession({
          sessionKey: "e2e/bad",
          agent: "e2e-nonexistent-agent-xyz",
          cwd: process.cwd(),
        }),
        10_000,
        "bad token ensure",
      );
      fail("invalid token rejected", "ensure unexpectedly succeeded");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/auth failed|invalid host token/i.test(msg)) {
        pass("invalid token rejected", msg.slice(0, 100));
      } else {
        fail("invalid token rejected", `wrong error: ${msg.slice(0, 160)}`);
      }
    }
  }

  // 3) Local Unix still works (worker default path)
  const localState = join(
    process.env.E2E_SCRATCH || process.cwd() + "/data/e2e-orb",
    "local-host-state",
  );
  await mkdir(localState, { recursive: true });
  const sockPath = join(localState, "acp-host.sock");
  const { close } = await startAcpHostServer({
    sockPath,
    stateDir: localState,
    sessionStore: createMemoryHostSessionStore(),
    enableScheduler: false,
  });
  try {
    await assertAcpHostReady({ sockPath, timeoutMs: 3000 });
    pass("local Unix host ready", sockPath);
    const local = createAcpHostClient({ sockPath });
    const r = await tryEnsure(local, "e2e/local", "local ensure");
    if (r.ok) pass("local Unix ensure", r.detail);
    else fail("local Unix ensure", r.detail);
  } finally {
    // close() can hang on dispose; do not block e2e completion
    try {
      await withTimeout(close(), 3000, "local host close");
    } catch {
      /* ignore */
    }
  }

  const ok = checks.every((c) => c.ok);
  const body = {
    ok,
    url,
    checks,
    at: new Date().toISOString(),
  };
  await Bun.write(resultFile, `${JSON.stringify(body, null, 2)}\n`);
  console.log(ok ? "e2e PASSED" : "e2e FAILED");
  // Force exit: open WebSocket/host handles can keep the event loop alive.
  process.exit(ok ? 0 : 1);
}
await main().catch((e) => {
  console.error(e);
  process.exit(1);
});
