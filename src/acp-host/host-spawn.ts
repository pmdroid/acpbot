/**
 * Host-side multi-agent spawn (no Telegram worker).
 * Reuses core agentSpawn + worktrees; children are headless host slots.
 */
import {
  agentKill,
  agentList,
  agentSpawn,
  type AgentSpawnConfig,
  type SpawnDeps,
} from "../core/agent-spawn";
import type { SpawnRecord } from "../core/agent-spawn-registry";
import type { SessionHost } from "../acp/session-host";
import type { PermissionMode } from "../env/types";

export type HostSpawnEnsureSlot = (input: {
  slotKey: string;
  agent: string;
  cwd: string;
  permissionMode?: PermissionMode;
}) => Promise<{
  host: SessionHost;
  agentSessionId: string | null;
  permissionMode?: PermissionMode;
  busy: boolean;
}>;

export type HostSpawnEnv = {
  stateDir: string;
  repos: Record<string, string>;
  defaultAgent: string;
  agentSpawnConfig?: AgentSpawnConfig;
  ensureSlot: HostSpawnEnsureSlot;
  /** Dispose/kill a live slot. */
  killSlot: (slotKey: string) => Promise<void>;
  /** Permission mode for new children (inherit from parent when possible). */
  defaultPermissionMode?: PermissionMode;
};

function repoKeyOf(sessionKey: string): string {
  const i = sessionKey.indexOf("/");
  return i > 0 ? sessionKey.slice(0, i) : sessionKey;
}

async function resolveParentCwd(
  env: HostSpawnEnv,
  parentSlotKey: string,
): Promise<{ cwd: string; permissionMode: PermissionMode; agent: string }> {
  // Prefer live/ensured parent
  try {
    const repo = repoKeyOf(parentSlotKey);
    const repoPath = env.repos[repo];
    if (!repoPath) {
      throw new Error(
        `unknown repo "${repo}" for parent ${parentSlotKey} — set [repos]`,
      );
    }
    const parent = await env.ensureSlot({
      slotKey: parentSlotKey,
      agent: env.defaultAgent,
      cwd: repoPath,
      permissionMode: env.defaultPermissionMode ?? "ask",
    });
    // Parent cwd may already be a worktree; use it as git root for children
    return {
      cwd: repoPath, // always primary repo root for worktree create
      permissionMode:
        parent.permissionMode ?? env.defaultPermissionMode ?? "ask",
      agent: env.defaultAgent,
    };
  } catch (e) {
    throw e;
  }
}

function buildDeps(
  env: HostSpawnEnv,
  parentSessionKey: string,
  parentRepoRoot: string,
  permissionMode: PermissionMode,
): SpawnDeps {
  return {
    stateDir: env.stateDir,
    parentRepoRoot,
    parentSessionKey,
    repoKey: repoKeyOf(parentSessionKey),
    ...(env.agentSpawnConfig ? { config: env.agentSpawnConfig } : {}),
    createChildSession: async (input) => {
      await env.ensureSlot({
        slotKey: input.sessionKey,
        agent: input.agent,
        cwd: input.cwd,
        permissionMode,
      });
      return { sessionKey: input.sessionKey };
    },
    ensureAndMaybePrompt: async (input) => {
      const slot = await env.ensureSlot({
        slotKey: input.sessionKey,
        agent: input.agent,
        cwd: input.cwd,
        permissionMode,
      });
      if (!input.prompt?.trim()) return;
      if (slot.busy) {
        return { summary: "(child busy — kickoff skipped)" };
      }
      let summary = "";
      const turn = slot.host.startTurn({
        sessionKey: input.sessionKey,
        text: input.prompt.trim(),
      });
      for await (const ev of turn.events) {
        if (ev.type === "text_delta" && ev.stream !== "thought" && ev.text) {
          summary += ev.text;
        }
      }
      await turn.result;
      return { summary: summary.trim().slice(0, 4000) };
    },
  };
}

export async function hostAgentSpawn(
  env: HostSpawnEnv,
  input: {
    parentSlotKey: string;
    name: string;
    agent?: string;
    role?: string;
    prompt?: string;
    /** Override child permission mode (default: bypass for host-only spawn). */
    permissionMode?: PermissionMode;
  },
): Promise<SpawnRecord> {
  const parent = await resolveParentCwd(env, input.parentSlotKey);
  // Host-only spawn has no Telegram keyboard on the child — default bypass
  // so kickoff tools work; CLI can re-ensure with ask later if desired.
  const perm =
    input.permissionMode ??
    env.defaultPermissionMode ??
    parent.permissionMode ??
    "bypass";
  const deps = buildDeps(env, input.parentSlotKey, parent.cwd, perm);
  return agentSpawn(deps, {
    name: input.name,
    agent: (input.agent?.trim() || env.defaultAgent || "grok-build").trim(),
    headless: true,
    ...(input.role ? { role: input.role } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
  });
}

export async function hostAgentList(
  stateDir: string,
  parentSlotKey: string,
): Promise<SpawnRecord[]> {
  return agentList(stateDir, parentSlotKey);
}

export async function hostAgentKill(
  env: HostSpawnEnv,
  input: {
    callerSlotKey: string;
    childSlotKey: string;
    dispose?: boolean;
    removeWorktree?: boolean;
  },
): Promise<SpawnRecord | undefined> {
  const repo = repoKeyOf(input.callerSlotKey);
  const parentRepoRoot = env.repos[repo];
  if (!parentRepoRoot) {
    throw new Error(`unknown repo "${repo}" for kill`);
  }
  return agentKill({
    stateDir: env.stateDir,
    parentRepoRoot,
    callerSessionKey: input.callerSlotKey,
    childSessionKey: input.childSlotKey,
    ...(env.agentSpawnConfig ? { config: env.agentSpawnConfig } : {}),
    ...(input.dispose !== undefined ? { dispose: input.dispose } : {}),
    ...(input.removeWorktree !== undefined
      ? { removeWorktree: input.removeWorktree }
      : {}),
    killSession: async (sessionKey) => {
      await env.killSlot(sessionKey);
    },
  });
}
