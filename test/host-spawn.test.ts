/**
 * Host-reachable multi-agent spawn (PAS-120) — unit test with fake slots.
 * Full agent ACP spawn is covered by live agent tests elsewhere.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hostAgentKill,
  hostAgentList,
  hostAgentSpawn,
  type HostSpawnEnv,
} from "../src/acp-host/host-spawn";
import { loadSpawnIndex } from "../src/core/agent-spawn-registry";
import { isGitWorkTree } from "../src/core/agent-worktree";
import type { SessionHost } from "../src/acp/session-host";

async function initGitRepo(dir: string): Promise<void> {
  const run = async (args: string[]) => {
    const p = Bun.spawn(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await p.exited;
    if (code !== 0) {
      const err = await new Response(p.stderr).text();
      throw new Error(`git ${args.join(" ")} failed: ${err}`);
    }
  };
  await run(["init"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);
  await Bun.write(join(dir, "README.md"), "# t\n");
  await run(["add", "."]);
  await run(["commit", "-m", "init"]);
}

function fakeHost(): SessionHost {
  return {
    setHooks() {},
    async ensureSession(input) {
      return {
        sessionKey: input.sessionKey,
        agentSessionId: `sid-${input.sessionKey}`,
        cwd: input.cwd,
        agent: input.agent,
        currentModeId: "default",
        availableModeIds: ["default"],
        configOptions: [],
      };
    },
    startTurn(input) {
      const text = input.text;
      return {
        events: (async function* () {
          yield { type: "text_delta" as const, text: `echo:${text}` };
          yield { type: "done" as const, stopReason: "end_turn" };
        })(),
        result: Promise.resolve({
          status: "completed",
          stopReason: "end_turn",
        }),
        cancel: async () => {},
      };
    },
    async cancel() {},
    async setMode() {
      return { currentModeId: "default", availableModeIds: ["default"] };
    },
    async getModeState() {
      return { currentModeId: "default", availableModeIds: ["default"] };
    },
    async getAvailableModes() {
      return ["default"];
    },
    async getConfigOptions() {
      return [];
    },
    async setConfigOption() {
      return [];
    },
    async disposeSession() {},
    async dispose() {},
  };
}

describe("host spawn (PAS-120)", () => {
  test("spawn worktree + registry; list/kill without Telegram", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "host-spawn-st-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "host-spawn-repo-"));
    await initGitRepo(repoRoot);

    const killed: string[] = [];
    const ensured: string[] = [];

    const env: HostSpawnEnv = {
      stateDir,
      repos: { demo: repoRoot },
      defaultAgent: "grok-build",
      defaultPermissionMode: "bypass",
      agentSpawnConfig: {
        maxChildrenPerParent: 4,
        maxDepth: 2,
        maxConcurrentSpawned: 8,
      },
      ensureSlot: async (input) => {
        ensured.push(input.slotKey);
        return {
          host: fakeHost(),
          agentSessionId: "x",
          permissionMode: input.permissionMode ?? "bypass",
          busy: false,
        };
      },
      killSlot: async (slotKey) => {
        killed.push(slotKey);
      },
    };

    try {
      const rec = await hostAgentSpawn(env, {
        parentSlotKey: "demo/main",
        name: "impl",
        agent: "grok-build",
        prompt: "hello child",
        permissionMode: "bypass",
      });
      expect(rec.childSessionKey).toBe("demo/main--impl");
      expect(rec.parentSessionKey).toBe("demo/main");
      expect(await isGitWorkTree(rec.worktreePath)).toBe(true);
      expect(ensured).toContain("demo/main");
      expect(ensured).toContain("demo/main--impl");
      // kickoff summary from fake host
      expect(rec.lastResultSummary).toContain("echo:hello child");

      const kids = await hostAgentList(stateDir, "demo/main");
      expect(kids.map((k) => k.childSessionKey)).toContain("demo/main--impl");

      const idx = await loadSpawnIndex(stateDir);
      expect(idx.byChild["demo/main--impl"]).toBeTruthy();

      await hostAgentKill(env, {
        callerSlotKey: "demo/main",
        childSlotKey: "demo/main--impl",
        dispose: true,
      });
      expect(killed).toContain("demo/main--impl");
      const after = await loadSpawnIndex(stateDir);
      expect(after.byChild["demo/main--impl"]).toBeUndefined();
    } finally {
      await rm(stateDir, { recursive: true, force: true }).catch(() => {});
      await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);
});
