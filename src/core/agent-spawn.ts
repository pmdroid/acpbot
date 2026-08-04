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
  isSpawnIdleCloseable,
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
  /**
   * Soft-close children idle this many hours (process stop, session kept).
   * 0 = disabled. Default applied by daemon (24).
   */
  idleCloseHours?: number;
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
    /** Default true — no Telegram topic. */
    headless?: boolean;
  }) => Promise<{ sessionKey: string; messageThreadId?: number }>;
  /**
   * Ensure host slot + optional first prompt.
   * When a kickoff prompt finishes, return its text summary so the registry
   * can store lastResultSummary (markChildResult also works if child is
   * already registered).
   */
  ensureAndMaybePrompt: (input: {
    sessionKey: string;
    agent: string;
    cwd: string;
    prompt?: string;
  }) => Promise<void | { summary?: string }>;
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
    /** Default true — no Telegram topic; permissions on parent. */
    headless?: boolean;
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
  const headless = input.headless !== false;
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
    headless,
  };

  try {
    await deps.createChildSession({
      sessionKey: childKey,
      parentSessionKey: deps.parentSessionKey,
      cwd: wt.worktreePath,
      agent: record.agent,
      spawnRunId: runId,
      headless,
      ...(input.role ? { role: input.role } : {}),
    });
    // Register before kickoff so markChildResult / wait can see the child.
    index = addSpawnRecord(index, record);
    await saveSpawnIndex(deps.stateDir, index);

    const promptResult = await deps.ensureAndMaybePrompt({
      sessionKey: childKey,
      agent: record.agent,
      cwd: wt.worktreePath,
      ...(input.prompt ? { prompt: input.prompt } : {}),
    });

    // Reload — kickoff may have written lastResultSummary via markChildResult.
    index = await loadSpawnIndex(deps.stateDir);
    // If the registry file was clobbered/missing, re-insert from memory.
    if (!index.byChild[childKey]) {
      index = addSpawnRecord(index, record);
    }
    let final = index.byChild[childKey]!;
    const kickoffSummary =
      (promptResult &&
      typeof promptResult === "object" &&
      typeof promptResult.summary === "string"
        ? promptResult.summary.trim()
        : "") || final.lastResultSummary;

    // Kickoff is synchronous for the spawn call: when it returns, the child
    // is not mid-turn. Terminal status so agent_wait can complete.
    const nextStatus: SpawnStatus =
      final.status === "failed" || final.status === "killed"
        ? final.status
        : "idle";
    index = updateSpawnRecord(index, childKey, {
      status: nextStatus,
      ...(kickoffSummary
        ? { lastResultSummary: kickoffSummary.slice(0, 4000) }
        : {}),
      updatedAt: deps.now?.() ?? Date.now(),
    });
    await saveSpawnIndex(deps.stateDir, index);
    final = index.byChild[childKey]!;
    return final;
  } catch (err) {
    // Rollback registry + worktree
    try {
      let idx = await loadSpawnIndex(deps.stateDir);
      if (idx.byChild[childKey]) {
        idx = removeSpawnRecord(idx, childKey);
        await saveSpawnIndex(deps.stateDir, idx);
      }
    } catch {
      /* */
    }
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

/**
 * Soft-close: stop host agent process, keep worktree + registry + Telegram
 * session so the child can be restored on next message / agent_send.
 */
export async function agentClose(
  deps: Pick<SpawnDeps, "stateDir" | "config" | "now"> & {
    callerSessionKey: string;
    childSessionKey: string;
    reason?: string;
    /** Stop host slot / process (prefer disposeSession over cancel-only). */
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

  if (rec.status === "closed") {
    return rec;
  }

  try {
    await deps.killSession?.(deps.childSessionKey);
  } catch {
    /* */
  }

  const now = deps.now?.() ?? Date.now();
  index = updateSpawnRecord(index, deps.childSessionKey, {
    status: "closed",
    closedAt: now,
    closeReason: (deps.reason?.trim() || "closed").slice(0, 200),
    updatedAt: now,
  });
  await saveSpawnIndex(deps.stateDir, index);
  return index.byChild[deps.childSessionKey];
}

/**
 * Mark a closed child active again (after ensureSession / new turn).
 */
export async function agentMarkRestored(
  stateDir: string,
  childSessionKey: string,
  now?: () => number,
): Promise<SpawnRecord | undefined> {
  let index = await loadSpawnIndex(stateDir);
  const rec = index.byChild[childSessionKey];
  if (!rec) return undefined;
  if (rec.status !== "closed") return rec;
  const t = now?.() ?? Date.now();
  index = updateSpawnRecord(index, childSessionKey, {
    status: "idle",
    updatedAt: t,
    closedAt: undefined,
    closeReason: undefined,
  });
  // Clear closed fields explicitly (spread keeps undefined patches).
  const next = {
    ...index.byChild[childSessionKey]!,
  };
  delete next.closedAt;
  delete next.closeReason;
  index = {
    byChild: { ...index.byChild, [childSessionKey]: next },
    byParent: index.byParent,
  };
  await saveSpawnIndex(stateDir, index);
  return next;
}

/**
 * Kill child.
 * - dispose=true (default): hard cleanup — remove worktree (if configured) + registry.
 * - dispose=false: soft-close — stop process, keep registry as `closed` + worktree.
 */
export async function agentKill(
  deps: Pick<
    SpawnDeps,
    "stateDir" | "parentRepoRoot" | "config" | "now"
  > & {
    callerSessionKey: string;
    childSessionKey: string;
    dispose?: boolean;
    reason?: string;
    /** Cancel host turn / dispose slot. */
    killSession?: (sessionKey: string) => Promise<void>;
  },
): Promise<SpawnRecord | undefined> {
  // Soft-close path
  if (deps.dispose === false) {
    return agentClose({
      stateDir: deps.stateDir,
      callerSessionKey: deps.callerSessionKey,
      childSessionKey: deps.childSessionKey,
      reason: deps.reason ?? "kill dispose=false",
      now: deps.now,
      killSession: deps.killSession,
      config: deps.config,
    });
  }

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
  if (cfg.removeWorktreeOnKill) {
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

/** List children eligible for auto idle soft-close. */
export async function listIdleCloseableChildren(
  stateDir: string,
  idleCloseMs: number,
  nowMs?: number,
): Promise<SpawnRecord[]> {
  if (idleCloseMs <= 0) return [];
  const index = await loadSpawnIndex(stateDir);
  const now = nowMs ?? Date.now();
  return Object.values(index.byChild).filter((rec) =>
    isSpawnIdleCloseable(rec, now, idleCloseMs),
  );
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
        rec.status === "closed" ||
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
