/**
 * Multi-agent spawn orchestration (worktree + registry + session hooks).
 * Daemon/worker-api inject Telegram session create + prompt delivery.
 */
import { randomUUID } from "node:crypto";
import {
  addSpawnRecord,
  authorizeAgentPeer,
  childSessionKey,
  depthOfSessionKey,
  listChildren,
  loadSpawnIndex,
  removeSpawnRecord,
  resolveAgentTarget,
  saveSpawnIndex,
  updateSpawnRecord,
  validateChildSlug,
  type SpawnIndex,
  type SpawnRecord,
  type SpawnStatus,
} from "./agent-spawn-registry";
import {
  childBranchName,
  createAgentWorktree,
  defaultWorktreePath,
  removeAgentWorktree,
} from "./agent-worktree";

export type AgentSpawnConfig = {
  maxChildrenPerParent?: number;
  maxDepth?: number;
  maxConcurrentSpawned?: number;
  branchPrefix?: string;
  worktreeRoot?: string;
  removeWorktreeOnKill?: boolean;
  deleteBranchOnKill?: boolean;
};

export type SpawnDeps = {
  stateDir: string;
  /** Absolute primary repo root (parent cwd). */
  parentRepoRoot: string;
  parentSessionKey: string;
  repoKey: string;
  config?: AgentSpawnConfig;
  now?: () => number;
  /**
   * Create Telegram topic + durable session with parent link.
   * cwd must be the worktree path.
   */
  createChildSession: (input: {
    sessionKey: string;
    parentSessionKey: string;
    cwd: string;
    agent: string;
    spawnRunId: string;
    role?: string;
  }) => Promise<{ sessionKey: string; messageThreadId?: number }>;
  /** Ensure host slot + optional first prompt. */
  ensureAndMaybePrompt: (input: {
    sessionKey: string;
    agent: string;
    cwd: string;
    prompt?: string;
  }) => Promise<void>;
  /** Deliver A2A message as a prompt turn on target. */
  deliverMessage?: (input: {
    sessionKey: string;
    message: string;
    mode?: "prompt" | "steer";
  }) => Promise<{ summary?: string }>;
  /** Is target slot currently mid-turn? */
  isBusy?: (sessionKey: string) => boolean | Promise<boolean>;
};

const DEFAULTS = {
  maxChildrenPerParent: 4,
  maxDepth: 2,
  maxConcurrentSpawned: 8,
  branchPrefix: "acpbot/",
  removeWorktreeOnKill: true,
  deleteBranchOnKill: false,
};

export async function agentSpawn(
  deps: SpawnDeps,
  input: {
    name: string;
    agent: string;
    role?: string;
    prompt?: string;
  },
): Promise<SpawnRecord> {
  const cfg = { ...DEFAULTS, ...deps.config };
  const slug = validateChildSlug(input.name);
  const parentDepth = depthOfSessionKey(deps.parentSessionKey);
  if (parentDepth >= cfg.maxDepth) {
    throw new Error(
      `max spawn depth ${cfg.maxDepth} reached (parent depth ${parentDepth})`,
    );
  }

  let index = await loadSpawnIndex(deps.stateDir);
  const siblings = listChildren(index, deps.parentSessionKey);
  if (siblings.length >= cfg.maxChildrenPerParent) {
    throw new Error(
      `max children per parent (${cfg.maxChildrenPerParent}) reached`,
    );
  }
  const total = Object.keys(index.byChild).length;
  if (total >= cfg.maxConcurrentSpawned) {
    throw new Error(
      `max concurrent spawned agents (${cfg.maxConcurrentSpawned}) reached`,
    );
  }

  const childKey = childSessionKey(deps.parentSessionKey, slug);
  if (index.byChild[childKey]) {
    throw new Error(`child already exists: ${childKey}`);
  }

  const branch = childBranchName(
    deps.parentSessionKey,
    slug,
    cfg.branchPrefix,
  );
  const worktreePath = defaultWorktreePath(
    cfg.worktreeRoot || deps.stateDir,
    deps.repoKey,
    childKey,
  );

  const wt = await createAgentWorktree({
    repoRoot: deps.parentRepoRoot,
    worktreePath,
    branch,
  });

  const now = deps.now?.() ?? Date.now();
  const runId = randomUUID();
  const record: SpawnRecord = {
    runId,
    childSessionKey: childKey,
    parentSessionKey: deps.parentSessionKey,
    agent: input.agent.trim() || "grok-build",
    ...(input.role ? { role: input.role } : {}),
    status: "starting",
    worktreePath: wt.worktreePath,
    branch: wt.branch,
    baseRef: wt.baseRef,
    depth: parentDepth + 1,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await deps.createChildSession({
      sessionKey: childKey,
      parentSessionKey: deps.parentSessionKey,
      cwd: wt.worktreePath,
      agent: record.agent,
      spawnRunId: runId,
      ...(input.role ? { role: input.role } : {}),
    });
    await deps.ensureAndMaybePrompt({
      sessionKey: childKey,
      agent: record.agent,
      cwd: wt.worktreePath,
      ...(input.prompt ? { prompt: input.prompt } : {}),
    });
    record.status = input.prompt ? "running" : "idle";
    record.updatedAt = deps.now?.() ?? Date.now();
    index = addSpawnRecord(index, record);
    await saveSpawnIndex(deps.stateDir, index);
    return record;
  } catch (err) {
    // Rollback worktree
    try {
      await removeAgentWorktree({
        repoRoot: deps.parentRepoRoot,
        worktreePath: wt.worktreePath,
        branch: wt.branch,
        removeWorktree: true,
        deleteBranch: true,
      });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

export async function agentList(
  stateDir: string,
  parentSessionKey: string,
): Promise<SpawnRecord[]> {
  const index = await loadSpawnIndex(stateDir);
  return listChildren(index, parentSessionKey);
}

export async function agentKill(
  deps: Pick<
    SpawnDeps,
    "stateDir" | "parentRepoRoot" | "config" | "now"
  > & {
    callerSessionKey: string;
    childSessionKey: string;
    dispose?: boolean;
    /** Cancel host turn / dispose slot. */
    killSession?: (sessionKey: string) => Promise<void>;
  },
): Promise<SpawnRecord | undefined> {
  let index = await loadSpawnIndex(deps.stateDir);
  const rec = index.byChild[deps.childSessionKey];
  if (!rec) return undefined;
  const auth = authorizeAgentPeer(
    index,
    deps.callerSessionKey,
    deps.childSessionKey,
  );
  if (!auth.ok) throw new Error(auth.error);

  try {
    await deps.killSession?.(deps.childSessionKey);
  } catch {
    /* */
  }

  const cfg = { ...DEFAULTS, ...deps.config };
  if (deps.dispose !== false && cfg.removeWorktreeOnKill) {
    try {
      await removeAgentWorktree({
        repoRoot: deps.parentRepoRoot,
        worktreePath: rec.worktreePath,
        branch: rec.branch,
        removeWorktree: true,
        deleteBranch: cfg.deleteBranchOnKill,
      });
    } catch {
      /* */
    }
  }

  index = updateSpawnRecord(index, deps.childSessionKey, {
    status: "killed",
    updatedAt: deps.now?.() ?? Date.now(),
  });
  index = removeSpawnRecord(index, deps.childSessionKey);
  await saveSpawnIndex(deps.stateDir, index);
  return { ...rec, status: "killed" };
}

export async function agentSend(
  deps: SpawnDeps & { callerSessionKey: string },
  input: { to: string; message: string; mode?: "prompt" | "steer" },
): Promise<{ to: string; summary?: string }> {
  const index = await loadSpawnIndex(deps.stateDir);
  const target = resolveAgentTarget(index, deps.callerSessionKey, input.to);
  const auth = authorizeAgentPeer(index, deps.callerSessionKey, target);
  if (!auth.ok) throw new Error(auth.error);
  if (!deps.deliverMessage) {
    throw new Error("deliverMessage not configured");
  }
  const envelope =
    `[acpbot-a2a from=${deps.callerSessionKey} to=${target}]\n` +
    input.message.trim();
  const r = await deps.deliverMessage({
    sessionKey: target,
    message: envelope,
    mode: input.mode ?? "prompt",
  });
  // If messaging a child, update summary when result returned
  if (index.byChild[target] && r.summary) {
    const next = updateSpawnRecord(index, target, {
      status: "idle",
      lastResultSummary: r.summary,
      updatedAt: deps.now?.() ?? Date.now(),
    });
    await saveSpawnIndex(deps.stateDir, next);
  }
  return { to: target, summary: r.summary };
}

export async function agentWait(
  deps: {
    stateDir: string;
    callerSessionKey: string;
    childSessionKey: string;
    timeoutSec?: number;
    pollSec?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    isBusy?: (sessionKey: string) => boolean | Promise<boolean>;
  },
): Promise<{
  status: SpawnStatus | "timeout";
  summary?: string;
  sessionKey: string;
}> {
  const index0 = await loadSpawnIndex(deps.stateDir);
  const auth = authorizeAgentPeer(
    index0,
    deps.callerSessionKey,
    deps.childSessionKey,
  );
  if (!auth.ok) throw new Error(auth.error);
  if (!index0.byChild[deps.childSessionKey]) {
    throw new Error(`unknown child: ${deps.childSessionKey}`);
  }

  const timeoutMs = (deps.timeoutSec ?? 600) * 1000;
  const pollMs = Math.max(200, (deps.pollSec ?? 2) * 1000);
  const sleep =
    deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = deps.now?.() ?? Date.now();

  for (;;) {
    const index = await loadSpawnIndex(deps.stateDir);
    const rec = index.byChild[deps.childSessionKey];
    if (!rec) {
      return {
        status: "killed",
        sessionKey: deps.childSessionKey,
      };
    }
    const busy = deps.isBusy
      ? await deps.isBusy(deps.childSessionKey)
      : rec.status === "running" || rec.status === "starting";
    if (
      !busy &&
      (rec.status === "idle" ||
        rec.status === "done" ||
        rec.status === "failed" ||
        rec.status === "killed")
    ) {
      return {
        status: rec.status,
        summary: rec.lastResultSummary,
        sessionKey: deps.childSessionKey,
      };
    }
    const now = deps.now?.() ?? Date.now();
    if (now - start >= timeoutMs) {
      return {
        status: "timeout",
        summary: rec.lastResultSummary,
        sessionKey: deps.childSessionKey,
      };
    }
    await sleep(pollMs);
  }
}

export async function markChildResult(
  stateDir: string,
  childSessionKey: string,
  summary: string,
  status: SpawnStatus = "idle",
): Promise<void> {
  let index = await loadSpawnIndex(stateDir);
  if (!index.byChild[childSessionKey]) return;
  index = updateSpawnRecord(index, childSessionKey, {
    status,
    lastResultSummary: summary.slice(0, 4000),
    updatedAt: Date.now(),
  });
  await saveSpawnIndex(stateDir, index);
}

export type { SpawnRecord, SpawnIndex, SpawnStatus };
