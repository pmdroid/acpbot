/**
 * Live ACP probes against agents installed on this machine.
 *
 * Spawns real agent stdio processes via createSessionHost and validates
 * ensureSession / getConfigOptions / setConfigOption / setMode / dispose.
 *
 * Agents not on PATH are skipped (listRegisteredAgents filters them).
 * Claude/Codex adapters may need network for first npx fetch + auth.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentDisplayName,
  isAgentAvailable,
  listRegisteredAgents,
  resolveAgentLaunch,
} from "../src/acp/agent-launch";
import {
  findModelConfigOption,
  type SessionConfigOptionView,
} from "../src/acp/session-config";
import { createSessionHost, type SessionHost } from "../src/acp/session-host";
import { silentLogger } from "../src/env/logger";
import type { TacpConfig } from "../src/env/types";

const LIVE = process.env.TACP_SKIP_LIVE_ACP !== "1";
const TIMEOUT_MS = Number(process.env.TACP_LIVE_ACP_TIMEOUT_MS ?? 90_000);

const minimalConfig = {
  operatorUserId: 1,
  repos: {},
  mcpEnabled: false,
  defaultAgent: "grok-build",
} as TacpConfig;

function makeHost(stateDir: string): SessionHost {
  return createSessionHost({
    config: minimalConfig,
    stateDir,
    mcpEnabled: false,
    log: silentLogger(),
  });
}

const available = LIVE ? listRegisteredAgents() : [];

describe("listRegisteredAgents (live PATH)", () => {
  test("no duplicates and every id is available", () => {
    const ids = listRegisteredAgents();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isAgentAvailable(id)).toBe(true);
      expect(resolveAgentLaunch(id).command.length).toBeGreaterThan(0);
      expect(agentDisplayName(id).length).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!LIVE || available.length === 0)("live ACP agents", () => {
  let stateDir = "";
  const hosts: SessionHost[] = [];

  afterAll(async () => {
    for (const h of hosts) {
      try {
        await h.dispose();
      } catch {
        /* ignore */
      }
    }
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test(
    "state dir setup",
    async () => {
      stateDir = await mkdtemp(join(tmpdir(), "tacp-live-acp-"));
    },
    10_000,
  );

  for (const agent of available) {
    test(
      `${agentDisplayName(agent)} (${agent}): ensureSession + models API`,
      async () => {
        if (!stateDir) {
          stateDir = await mkdtemp(join(tmpdir(), "tacp-live-acp-"));
        }
        const host = makeHost(stateDir);
        hosts.push(host);
        const sessionKey = `live/${agent}`;
        const cwd = process.cwd();

        const session = await host.ensureSession({
          sessionKey,
          agent,
          cwd,
        });
        expect(session.sessionKey).toBe(sessionKey);
        expect(session.agent).toBe(agent);
        expect(session.agentSessionId.length).toBeGreaterThan(0);
        expect(session.cwd).toBe(cwd);

        // getConfigOptions should not throw
        const options = host.getConfigOptions(sessionKey);
        expect(Array.isArray(options)).toBe(true);

        const model = findModelConfigOption(options as SessionConfigOptionView[]);
        // Prefer agents that advertise models; if they do, list must be non-empty
        // and setConfigOption must update currentValue when multiple options exist.
        if (model && model.options.length > 0) {
          expect(model.options.length).toBeGreaterThan(0);
          expect(
            model.options.every(
              (o) => typeof o.value === "string" && o.value.length > 0,
            ),
          ).toBe(true);

          if (model.options.length > 1) {
            const current = String(model.currentValue ?? "");
            const target =
              model.options.find((o) => o.value !== current) ??
              model.options[0]!;
            const next = await host.setConfigOption(
              sessionKey,
              model.id,
              target.value,
            );
            const after = findModelConfigOption(next);
            expect(after).toBeDefined();
            expect(String(after!.currentValue)).toBe(target.value);
            // Catalog should still be present after switch
            expect(after!.options.length).toBeGreaterThan(0);
          }
        }

        // Mode API: only exercise when agent advertises modes
        const modes = host.getAvailableModes(sessionKey);
        if (modes.length > 0) {
          const state = host.getModeState(sessionKey);
          expect(state).toBeDefined();
          const pick =
            modes.find((m) => m !== state?.currentModeId) ?? modes[0]!;
          const afterMode = await host.setMode(sessionKey, pick);
          expect(afterMode.availableModeIds.length).toBeGreaterThan(0);
          expect(afterMode.currentModeId).toBe(pick);
        }

        // ensureSession is idempotent for same agent/cwd
        const again = await host.ensureSession({
          sessionKey,
          agent,
          cwd,
        });
        expect(again.agentSessionId).toBe(session.agentSessionId);

        await host.disposeSession(sessionKey);
        expect(host.getConfigOptions(sessionKey)).toEqual([]);
      },
      TIMEOUT_MS,
    );
  }

  test(
    "opencode advertises many models when installed",
    async () => {
      if (!isAgentAvailable("opencode")) return;
      if (!stateDir) {
        stateDir = await mkdtemp(join(tmpdir(), "tacp-live-acp-"));
      }
      const host = makeHost(stateDir);
      hosts.push(host);
      const sessionKey = "live/opencode-models";
      await host.ensureSession({
        sessionKey,
        agent: "opencode",
        cwd: process.cwd(),
      });
      const model = findModelConfigOption(host.getConfigOptions(sessionKey));
      expect(model).toBeDefined();
      expect(model!.options.length).toBeGreaterThan(1);
      await host.disposeSession(sessionKey);
    },
    TIMEOUT_MS,
  );

  test(
    "grok-build advertises session models when installed",
    async () => {
      if (!isAgentAvailable("grok-build")) return;
      if (!stateDir) {
        stateDir = await mkdtemp(join(tmpdir(), "tacp-live-acp-"));
      }
      const host = makeHost(stateDir);
      hosts.push(host);
      const sessionKey = "live/grok-models";
      await host.ensureSession({
        sessionKey,
        agent: "grok-build",
        cwd: process.cwd(),
      });
      const model = findModelConfigOption(host.getConfigOptions(sessionKey));
      expect(model).toBeDefined();
      expect(model!.options.length).toBeGreaterThan(0);
      expect(model!.options.some((o) => /grok/i.test(o.value))).toBe(true);
      await host.disposeSession(sessionKey);
    },
    TIMEOUT_MS,
  );
});
