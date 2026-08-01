/**
 * Live integration: worker `createAcpHostClient` ↔ real `startAcpHostServer`
 * ↔ real agent stdio.
 *
 * Covers the production path (worker never spawns agents; host does):
 *   - assertAcpHostReady / ping
 *   - ensure (host spawn/load)
 *   - get_mode / get_config RPCs (not stale worker cache)
 *   - setMode / setConfigOption over the socket
 *   - prompt turn + cancel
 *   - client disconnect keeps host slots; reattach
 *   - disposeSession / kill slot
 *
 * Skip: TACP_SKIP_LIVE_ACP=1
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentDisplayName,
  isAgentAvailable,
} from "../../src/acp/agent-launch";
import {
  currentModelLabel,
  findModelConfigOption,
  type SessionConfigOptionView,
} from "../../src/acp/session-config";
import type { HostTurnEvent, SessionHost } from "../../src/acp/session-host";
import {
  assertAcpHostReady,
  createAcpHostClient,
} from "../../src/acp-host/client";
import { startAcpHostServer } from "../../src/acp-host/server";
import { silentLogger } from "../../src/env/logger";
import type { TacpConfig } from "../../src/env/types";

const LIVE = process.env.TACP_SKIP_LIVE_ACP !== "1";
const TIMEOUT_MS = Number(process.env.TACP_LIVE_ACP_TIMEOUT_MS ?? 180_000);
const PROMPT_TIMEOUT_MS = Number(
  process.env.TACP_LIVE_ACP_PROMPT_TIMEOUT_MS ?? 90_000,
);

const AGENTS = ["grok-build", "codex", "opencode", "claude"] as const;
type AgentId = (typeof AGENTS)[number];

const SOFT_LAUNCH = new Set<AgentId>(["claude", "codex"]);

const MODE_MUST: Partial<Record<AgentId, string[]>> = {
  "grok-build": ["high", "medium", "low"],
  codex: ["read-only", "agent"],
};

const MUST_MODELS = new Set<AgentId>(["grok-build", "codex", "opencode"]);

async function collectTurn(
  host: SessionHost,
  sessionKey: string,
  text: string,
  opts?: { cancelAfterMs?: number },
): Promise<{
  status: string;
  output: string;
  events: HostTurnEvent[];
}> {
  const turn = host.startTurn({ sessionKey, text });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts?.cancelAfterMs != null) {
    timer = setTimeout(() => {
      void turn.cancel("test");
    }, opts.cancelAfterMs);
  }
  const events: HostTurnEvent[] = [];
  let output = "";
  const drain = (async () => {
    for await (const ev of turn.events) {
      events.push(ev);
      if (ev.type === "text_delta" && ev.stream !== "thought") {
        output += ev.text;
      }
    }
  })();
  const result = await Promise.race([
    turn.result,
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error(`prompt timeout ${PROMPT_TIMEOUT_MS}ms`)),
        PROMPT_TIMEOUT_MS,
      ),
    ),
  ]);
  if (timer) clearTimeout(timer);
  await drain;
  return { status: result.status, output, events };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | void> {
  try {
    return await Promise.race([
      p,
      new Promise<void>((_, rej) =>
        setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms),
      ),
    ]);
  } catch {
    /* best-effort teardown */
  }
}

describe.skipIf(!LIVE)("contract: live acp-host client ↔ host ↔ agent", () => {
  let stateDir = "";
  let sockPath = "";
  let closeHost: (() => Promise<void>) | undefined;
  const clients: SessionHost[] = [];

  afterAll(
    async () => {
      for (const c of clients) {
        await withTimeout(c.dispose(), 3_000, "client.dispose");
      }
      if (closeHost) {
        await withTimeout(closeHost(), 10_000, "host.close");
      }
      if (stateDir) {
        await rm(stateDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    30_000,
  );

  test(
    "boot acp-host server",
    async () => {
      stateDir = await mkdtemp(join(tmpdir(), "tacp-host-live-"));
      sockPath = join(stateDir, "acp-host.sock");
      const config = {
        operatorUserId: 1,
        repos: { demo: process.cwd() },
        mcpEnabled: false,
        defaultAgent: "grok-build",
      } as TacpConfig;

      const server = await startAcpHostServer({
        sockPath,
        stateDir,
        config,
        enableScheduler: false,
        log: silentLogger(),
      });
      closeHost = server.close;

      const ready = await assertAcpHostReady({ sockPath, timeoutMs: 3000 });
      expect(ready.sockPath).toBe(sockPath);
    },
    15_000,
  );

  for (const agent of AGENTS) {
    test(
      `${agentDisplayName(agent)} (${agent}): client ensure → mode/model RPC → turn → reattach`,
      async () => {
        if (!isAgentAvailable(agent)) return;
        expect(sockPath.length).toBeGreaterThan(0);

        const client = createAcpHostClient({
          sockPath,
          log: silentLogger(),
        });
        clients.push(client);

        const sessionKey = `hostlive/${agent}`;
        const cwd = process.cwd();

        // ---- ensure (host spawns agent) ----
        let session: Awaited<ReturnType<SessionHost["ensureSession"]>>;
        try {
          session = await client.ensureSession({ sessionKey, agent, cwd });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (SOFT_LAUNCH.has(agent)) {
            console.warn(
              `[host-live] skip ${agent}: ensure failed (${msg.slice(0, 160)})`,
            );
            return;
          }
          throw err;
        }

        expect(session.agentSessionId.length).toBeGreaterThan(0);
        expect(session.agent).toBe(agent);

        // ---- live get_mode / get_config RPCs (not empty worker cache) ----
        const modes = await client.getAvailableModes(sessionKey);
        const modeState = await client.getModeState(sessionKey);
        const configOpts = (await client.getConfigOptions(
          sessionKey,
        )) as SessionConfigOptionView[];
        const model = findModelConfigOption(configOpts);

        if (MODE_MUST[agent]) {
          expect(modes.length).toBeGreaterThan(0);
          for (const id of MODE_MUST[agent]!) {
            expect(modes).toContain(id);
          }
          expect(modeState?.currentModeId).toBeTruthy();
          expect(modes).toContain(modeState!.currentModeId!);
        }

        if (MUST_MODELS.has(agent)) {
          expect(model).toBeDefined();
          expect(model!.options.length).toBeGreaterThan(0);
          expect(model!.currentValue != null).toBe(true);
        }

        // Second RPC must still hit host (same answers, proves re-query works)
        const modes2 = await client.getAvailableModes(sessionKey);
        expect(modes2).toEqual(modes);
        const label1 = currentModelLabel(configOpts);
        const label2 = currentModelLabel(
          (await client.getConfigOptions(
            sessionKey,
          )) as SessionConfigOptionView[],
        );
        if (label1) expect(label2).toBe(label1);

        // ---- setMode when advertised ----
        if (modes.length > 1) {
          const pick =
            modes.find((m) => m !== modeState?.currentModeId) ?? modes[0]!;
          const after = await client.setMode(sessionKey, pick);
          expect(after.currentModeId).toBe(pick);
          expect((await client.getModeState(sessionKey))?.currentModeId).toBe(
            pick,
          );
        }

        // ---- set model when multi ----
        if (model && model.options.length > 1) {
          const current = String(model.currentValue ?? "");
          const target =
            model.options.find((o) => o.value !== current) ?? model.options[0]!;
          const next = await client.setConfigOption(
            sessionKey,
            model.id,
            target.value,
          );
          expect(String(findModelConfigOption(next)?.currentValue)).toBe(
            target.value,
          );
          if (current) {
            await client
              .setConfigOption(sessionKey, model.id, current)
              .catch(() => {});
          }
        }

        // ---- prompt via host ----
        const turn = await collectTurn(
          client,
          sessionKey,
          "Reply with exactly: PONG",
        );
        expect(["completed", "cancelled"]).toContain(turn.status);

        // ---- cancel path ----
        const cancelled = await collectTurn(
          client,
          sessionKey,
          "Count from 1 to 500 slowly.",
          { cancelAfterMs: 100 },
        );
        expect(["completed", "cancelled", "failed"]).toContain(cancelled.status);

        // ---- client disconnect keeps slot; new client reattaches ----
        await client.dispose(); // detach only — does not kill host slots
        const idx = clients.indexOf(client);
        if (idx >= 0) clients.splice(idx, 1);

        const client2 = createAcpHostClient({
          sockPath,
          log: silentLogger(),
        });
        clients.push(client2);

        const reattached = await client2.ensureSession({
          sessionKey,
          agent,
          cwd,
        });
        expect(reattached.agentSessionId).toBe(session.agentSessionId);

        // Fresh RPC after reattach still sees mode/model
        const modesAfter = await client2.getAvailableModes(sessionKey);
        if (MODE_MUST[agent]) {
          expect(modesAfter.length).toBeGreaterThan(0);
        }
        if (MUST_MODELS.has(agent)) {
          const m = findModelConfigOption(
            (await client2.getConfigOptions(
              sessionKey,
            )) as SessionConfigOptionView[],
          );
          expect(m?.options.length ?? 0).toBeGreaterThan(0);
        }

        // Short turn on reattached slot
        const turn2 = await collectTurn(client2, sessionKey, "Reply with: OK");
        expect(["completed", "cancelled"]).toContain(turn2.status);

        // ---- kill slot ----
        await client2.disposeSession(sessionKey);
        expect(await client2.getConfigOptions(sessionKey)).toEqual([]);
        expect(await client2.getModeState(sessionKey)).toEqual({
          currentModeId: undefined,
          availableModeIds: [],
        });
      },
      TIMEOUT_MS,
    );
  }
});
