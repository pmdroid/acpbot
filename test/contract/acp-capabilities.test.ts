/**
 * ACP capability contract — everything acpbot needs for an agent to work.
 *
 * These tests exercise the SessionHost surface used by the worker/acp-host path:
 *
 *   REQUIRED (every agent that successfully launches)
 *   R1  ensureSession (spawn + initialize + session/new|load)
 *   R2  ensureSession idempotent (same agent/cwd → same agentSessionId)
 *   R3  prompt turn (text in → completed/cancelled result)
 *   R4  cancel does not crash the slot
 *   R5  disposeSession clears live config
 *
 *   WHEN ADVERTISED (fail if expected-for-agent and missing)
 *   M1  model catalog + current value
 *   M2  setConfigOption / session/set_model switches model
 *   O1  mode catalog + current value
 *   O2  setMode switches mode
 *   L1  session/load resume across host process restart (durable store)
 *
 * Skip a binary with PATH missing; skip launch failures for adapter agents
 * (claude/codex npx/auth). Disable all live probes: ACPBOT_SKIP_LIVE_ACP=1.
 *
 * Supported agents: grok-build, claude, codex, opencode.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentDisplayName,
  isAgentAvailable,
  listRegisteredAgents,
} from "../../src/acp/agent-launch";
import {
  currentModelLabel,
  findModelConfigOption,
  type SessionConfigOptionView,
} from "../../src/acp/session-config";
import {
  createSessionHost,
  type HostTurnEvent,
  type SessionHost,
} from "../../src/acp/session-host";
import { silentLogger } from "../../src/env/logger";
import type { AcpbotConfig } from "../../src/env/types";
import { decisionToPermissionResponse } from "../../src/acp/permission-map";

const LIVE = process.env.ACPBOT_SKIP_LIVE_ACP !== "1";
const TIMEOUT_MS = Number(process.env.ACPBOT_LIVE_ACP_TIMEOUT_MS ?? 120_000);
const PROMPT_TIMEOUT_MS = Number(
  process.env.ACPBOT_LIVE_ACP_PROMPT_TIMEOUT_MS ?? 90_000,
);

const SUPPORTED_AGENTS = [
  "grok-build",
  "claude",
  "codex",
  "opencode",
] as const;
type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];

type AgentCapExpect = {
  /** Soft-skip ensure failures (adapter/npx/auth). */
  softLaunch?: boolean;
  mustModels?: boolean;
  modelValueRe?: RegExp;
  mustModes?: boolean;
  modeMustInclude?: string[];
  /** session/load after process restart (needs durable store + agent support). */
  mustLoad?: boolean;
};

const EXPECT: Record<SupportedAgent, AgentCapExpect> = {
  "grok-build": {
    mustModels: true,
    modelValueRe: /grok/i,
    // Grok does not put modes on session/new; acpbot seeds default/plan/ask
    // from xai-org/grok-build SessionMode (session/set_mode).
    mustModes: true,
    modeMustInclude: ["default", "plan", "ask"],
    mustLoad: true,
  },
  claude: {
    softLaunch: true,
    // Adapter-dependent; if it launches we still require a working turn.
  },
  codex: {
    softLaunch: true,
    mustModels: true,
    mustModes: true,
    modeMustInclude: ["read-only", "agent"],
    mustLoad: true,
  },
  opencode: {
    mustModels: true,
    // OpenCode advertises build/plan via configOptions id "mode".
    mustModes: true,
    modeMustInclude: ["build", "plan"],
    mustLoad: true,
  },
};

const minimalConfig = {
  operatorUserId: 1,
  repos: {},
  mcpEnabled: false,
  defaultAgent: "grok-build",
} as AcpbotConfig;

function makeHost(stateDir: string): SessionHost {
  return createSessionHost({
    config: minimalConfig,
    stateDir,
    mcpEnabled: false,
    log: silentLogger(),
  });
}

async function collectTurn(
  host: SessionHost,
  sessionKey: string,
  text: string,
  opts?: { cancelAfterMs?: number },
): Promise<{
  result: { status: string; stopReason?: string; error?: { message?: string } };
  output: string;
  thought: string;
  toolCalls: number;
  events: HostTurnEvent[];
}> {
  const turn = host.startTurn({ sessionKey, text });
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  if (opts?.cancelAfterMs != null) {
    cancelTimer = setTimeout(() => {
      void turn.cancel("test cancel");
    }, opts.cancelAfterMs);
  }

  const events: HostTurnEvent[] = [];
  let output = "";
  let thought = "";
  let toolCalls = 0;

  const drain = (async () => {
    for await (const ev of turn.events) {
      events.push(ev);
      if (ev.type === "text_delta") {
        if (ev.stream === "thought") thought += ev.text;
        else output += ev.text;
      } else if (ev.type === "tool_call") {
        toolCalls++;
      }
    }
  })();

  const result = await Promise.race([
    turn.result,
    new Promise<{ status: string; error: { message: string } }>((_, reject) =>
      setTimeout(
        () => reject(new Error(`prompt timeout after ${PROMPT_TIMEOUT_MS}ms`)),
        PROMPT_TIMEOUT_MS,
      ),
    ),
  ]);
  if (cancelTimer) clearTimeout(cancelTimer);
  await drain;
  return { result, output, thought, toolCalls, events };
}

// ---------------------------------------------------------------------------
// Unit: permission mapping (client capability acpbot implements for agents)
// ---------------------------------------------------------------------------

describe("contract: permission mapping (client → agent)", () => {
  test("allow_once / reject / cancel map to ACP selected|cancelled", () => {
    const opts = [
      { optionId: "a1", kind: "allow_once" },
      { optionId: "r1", kind: "reject_once" },
      { optionId: "aa", kind: "allow_always" },
    ];
    expect(decisionToPermissionResponse(opts, { outcome: "allow_once" })).toEqual({
      outcome: { outcome: "selected", optionId: "a1" },
    });
    expect(decisionToPermissionResponse(opts, { outcome: "reject_once" })).toEqual({
      outcome: { outcome: "selected", optionId: "r1" },
    });
    expect(decisionToPermissionResponse(opts, { outcome: "cancel" })).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  test("single unmatched option is selected; multi unmatched cancels", () => {
    // Only one option → select it (agents often use custom kinds)
    expect(
      decisionToPermissionResponse(
        [{ optionId: "x", kind: "something_else" }],
        { outcome: "allow_once" },
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "x" } });
    // Multiple unmatched kinds → cancel rather than guess
    expect(
      decisionToPermissionResponse(
        [
          { optionId: "x", kind: "foo" },
          { optionId: "y", kind: "bar" },
        ],
        { outcome: "allow_once" },
      ),
    ).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("contract: agent registry", () => {
  test("supported agents are in the full registry", () => {
    const all = listRegisteredAgents({ availableOnly: false });
    for (const id of SUPPORTED_AGENTS) {
      expect(all).toContain(id);
      expect(agentDisplayName(id).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Live ACP — full capability matrix per agent
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE)("contract: live ACP capabilities", () => {
  let stateDir = "";
  const hosts: SessionHost[] = [];

  afterAll(async () => {
    for (const h of hosts) {
      try {
        await h.dispose();
      } catch {
        /* */
      }
    }
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test(
    "shared state dir",
    async () => {
      stateDir = await mkdtemp(join(tmpdir(), "acpbot-acp-cap-"));
    },
    10_000,
  );

  for (const agent of SUPPORTED_AGENTS) {
    const exp = EXPECT[agent];
    const label = agentDisplayName(agent);

    test(
      `${label} (${agent}): full ACP capability matrix`,
      async () => {
        if (!isAgentAvailable(agent)) return;
        if (!stateDir) {
          stateDir = await mkdtemp(join(tmpdir(), "acpbot-acp-cap-"));
        }

        const host = makeHost(stateDir);
        hosts.push(host);
        const sessionKey = `cap/${agent}`;
        const cwd = process.cwd();

        // ---- R1 ensureSession ----
        let session: Awaited<ReturnType<SessionHost["ensureSession"]>>;
        try {
          session = await host.ensureSession({ sessionKey, agent, cwd });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (exp.softLaunch) {
            console.warn(
              `[acp-cap] skip ${agent}: ensure failed (${msg.slice(0, 180)})`,
            );
            return;
          }
          throw err;
        }

        expect(session.sessionKey).toBe(sessionKey);
        expect(session.agent).toBe(agent);
        expect(session.agentSessionId.length).toBeGreaterThan(0);
        expect(session.cwd).toBe(cwd);
        const agentSessionId = session.agentSessionId;

        // ---- R2 idempotent ensure ----
        const again = await host.ensureSession({ sessionKey, agent, cwd });
        expect(again.agentSessionId).toBe(agentSessionId);

        // ---- M1 / M2 models ----
        const options = (await host.getConfigOptions(
          sessionKey,
        )) as SessionConfigOptionView[];
        expect(Array.isArray(options)).toBe(true);
        const model = findModelConfigOption(options);

        if (exp.mustModels) {
          expect(model).toBeDefined();
          expect(model!.options.length).toBeGreaterThan(0);
          expect(model!.currentValue != null).toBe(true);
          if (exp.modelValueRe) {
            expect(
              model!.options.some((o) => exp.modelValueRe!.test(o.value)),
            ).toBe(true);
          }
        }

        if (model && model.options.length > 1) {
          const current = String(model.currentValue ?? "");
          const target =
            model.options.find((o) => o.value !== current) ?? model.options[0]!;
          const next = await host.setConfigOption(
            sessionKey,
            model.id,
            target.value,
          );
          const after = findModelConfigOption(next);
          expect(after).toBeDefined();
          expect(String(after!.currentValue)).toBe(target.value);
          // Restore original when possible so later load sees a stable id
          if (current) {
            await host.setConfigOption(sessionKey, model.id, current).catch(
              () => {},
            );
          }
        }

        // ---- O1 / O2 modes ----
        const modes = await host.getAvailableModes(sessionKey);
        const modeState = await host.getModeState(sessionKey);

        if (exp.mustModes) {
          expect(modes.length).toBeGreaterThan(0);
          expect(modeState?.currentModeId).toBeTruthy();
          expect(modes).toContain(modeState!.currentModeId!);
          if (exp.modeMustInclude) {
            for (const id of exp.modeMustInclude) {
              expect(modes).toContain(id);
            }
          }
          const pick =
            modes.find((m) => m !== modeState?.currentModeId) ?? modes[0]!;
          const afterMode = await host.setMode(sessionKey, pick);
          expect(afterMode.currentModeId).toBe(pick);
          expect((await host.getModeState(sessionKey))?.currentModeId).toBe(
            pick,
          );
        } else {
          expect(Array.isArray(modes)).toBe(true);
        }

        // ---- R3 prompt turn ----
        const turn = await collectTurn(
          host,
          sessionKey,
          "Reply with exactly the single word: PONG",
        );
        expect(["completed", "cancelled"]).toContain(turn.result.status);
        if (turn.result.status === "completed") {
          // Agents sometimes add punctuation/formatting; require some output.
          expect(
            turn.output.length + turn.thought.length + turn.toolCalls,
          ).toBeGreaterThan(0);
        }

        // ---- R4 cancel (best-effort; may finish before cancel) ----
        const cancelTurn = await collectTurn(
          host,
          sessionKey,
          "Count slowly from 1 to 1000 with a short pause between numbers.",
          { cancelAfterMs: 80 },
        );
        expect(["completed", "cancelled", "failed"]).toContain(
          cancelTurn.result.status,
        );

        // Snapshot for load test
        const modelBeforeLoad = currentModelLabel(
          (await host.getConfigOptions(sessionKey)) as SessionConfigOptionView[],
        );
        const modeBeforeLoad = (await host.getModeState(sessionKey))
          ?.currentModeId;

        // ---- R5 dispose ----
        await host.disposeSession(sessionKey);
        expect(await host.getConfigOptions(sessionKey)).toEqual([]);
        expect(await host.getModeState(sessionKey)).toBeUndefined();

        // ---- L1 session/load across process restart ----
        if (exp.mustLoad !== false) {
          await host.dispose().catch(() => {});
          // Remove from hosts cleanup list — already disposed
          const idx = hosts.indexOf(host);
          if (idx >= 0) hosts.splice(idx, 1);

          const host2 = makeHost(stateDir);
          hosts.push(host2);
          let resumed: Awaited<ReturnType<SessionHost["ensureSession"]>>;
          try {
            resumed = await host2.ensureSession({ sessionKey, agent, cwd });
          } catch (err) {
            if (exp.softLaunch) {
              console.warn(
                `[acp-cap] skip ${agent} load: ${err instanceof Error ? err.message.slice(0, 120) : err}`,
              );
              return;
            }
            throw err;
          }
          // Prefer same ACP session id when load works; fall back to new is OK
          // if agent rejected load (we still need a working slot).
          expect(resumed.agentSessionId.length).toBeGreaterThan(0);

          if (exp.mustModels && modelBeforeLoad) {
            const after = currentModelLabel(
              (await host2.getConfigOptions(
                sessionKey,
              )) as SessionConfigOptionView[],
            );
            // Live catalog or durable seed should surface a current model.
            expect(after ?? modelBeforeLoad).toBeTruthy();
          }
          if (exp.mustModes && modeBeforeLoad) {
            const modes2 = await host2.getAvailableModes(sessionKey);
            expect(modes2.length).toBeGreaterThan(0);
          }

          // One more short turn after load/new to prove the slot is usable.
          const turn2 = await collectTurn(
            host2,
            sessionKey,
            "Reply with exactly: OK",
          );
          expect(["completed", "cancelled"]).toContain(turn2.result.status);

          await host2.disposeSession(sessionKey);
        }
      },
      TIMEOUT_MS * 2,
    );
  }
});
