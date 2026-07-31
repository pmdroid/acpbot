/**
 * acp-host schedule ticker: scan catalog repos' `.tacp/schedules/`, fire due jobs.
 *
 * Due = enabled && nextRunAt <= now.
 * once → disable after fire; cron → recompute nextRunAt (catch-up once, not every miss).
 * Busy slot → lastStatus=busy, leave nextRunAt (retry next tick).
 */
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import { computeNextRunAt } from "../schedules/next-run";
import {
  listJobs,
  updateJob,
} from "../schedules/store";
import type { ScheduleJob, ScheduleJobStatus } from "../schedules/types";

export const DEFAULT_SCHEDULE_TICK_MS = 20_000;

export type FireJobResult = {
  status: ScheduleJobStatus;
  error?: string;
};

/**
 * Host-side ensure + prompt for a scheduled job.
 * Return `busy` when the slot is mid-turn (scheduler retries next tick).
 */
export type ScheduleFireFn = (args: {
  sessionKey: string;
  repoKey: string;
  repoRoot: string;
  text: string;
  job: ScheduleJob;
}) => Promise<FireJobResult>;

export type HostSchedulerOptions = {
  /** repoKey → absolute path (from TACP_REPOS_JSON / config). */
  repos: Record<string, string>;
  fire: ScheduleFireFn;
  /** Injectable clock (tests). */
  now?: () => Date;
  log?: Logger;
  /**
   * When true (default), jobs whose nextRunAt is far in the past still fire
   * only once this tick; cron next is computed from `now` (no multi-miss storm).
   */
  catchUpOnce?: boolean;
};

export type DueJob = {
  repoKey: string;
  repoRoot: string;
  job: ScheduleJob;
};

export type TickResult = {
  scanned: number;
  due: number;
  fired: number;
  busy: number;
  errors: number;
  skipped: number;
};

/** Parse TACP_REPOS_JSON the same way as loadConfig (quote strip + JSON). */
export function parseReposFromEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const raw0 = env.TACP_REPOS_JSON?.trim();
  if (!raw0) return {};
  let raw = raw0;
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    raw = raw.slice(1, -1);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === "string" && k.trim() && typeof v === "string" && v.trim()) {
        out[k.trim()] = v.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function scheduleTickMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.TACP_SCHEDULE_TICK_MS?.trim();
  if (!raw) return DEFAULT_SCHEDULE_TICK_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1000) return DEFAULT_SCHEDULE_TICK_MS;
  return Math.floor(n);
}

/** sessionKey = `repoKey/name` — first slash separates repo. */
export function repoKeyFromSessionKey(sessionKey: string): string | null {
  const i = sessionKey.indexOf("/");
  if (i <= 0 || i === sessionKey.length - 1) return null;
  return sessionKey.slice(0, i);
}

/**
 * Build the agent prompt envelope for a scheduled fire.
 */
export function buildFireEnvelope(job: ScheduleJob, cwd: string): string {
  const label = job.name?.trim() ? `${job.id} | ${job.name.trim()}` : job.id;
  const lines = [
    `[scheduled job ${label}]`,
    `It is time to execute this scheduled task for session ${job.sessionKey}.`,
    `Repo: ${cwd}`,
    "",
    "## Prompt",
    job.prompt,
  ];
  if (job.script?.trim()) {
    lines.push(
      "",
      "## Script (optional)",
      `Path: ${job.script.trim()}`,
      "",
      "When done, summarize what you did for the operator.",
    );
  } else {
    lines.push("", "When done, summarize what you did for the operator.");
  }
  return lines.join("\n");
}

export function isJobDue(job: ScheduleJob, now: Date): boolean {
  if (!job.enabled) return false;
  const t = Date.parse(job.nextRunAt);
  if (Number.isNaN(t)) return false;
  return t <= now.getTime();
}

/** Load all enabled+due jobs across catalog repos. */
export async function collectDueJobs(
  repos: Record<string, string>,
  now: Date,
): Promise<DueJob[]> {
  const due: DueJob[] = [];
  for (const [repoKey, repoRoot] of Object.entries(repos)) {
    if (!repoKey.trim() || !repoRoot.trim()) continue;
    let jobs: ScheduleJob[];
    try {
      jobs = await listJobs(repoRoot, { all: true });
    } catch {
      continue;
    }
    for (const job of jobs) {
      if (!isJobDue(job, now)) continue;
      // Job's session should belong to this catalog repo when sessionKey is well-formed.
      const skRepo = repoKeyFromSessionKey(job.sessionKey);
      if (skRepo != null && skRepo !== repoKey) {
        // Still fire using the catalog path we scanned — log-level concern for caller.
      }
      due.push({ repoKey, repoRoot, job });
    }
  }
  // Stable order: earliest nextRunAt first
  due.sort((a, b) => a.job.nextRunAt.localeCompare(b.job.nextRunAt));
  return due;
}

async function advanceAfterFire(
  repoRoot: string,
  job: ScheduleJob,
  status: ScheduleJobStatus,
  now: Date,
): Promise<ScheduleJob> {
  const nowIso = now.toISOString();
  if (job.kind === "once") {
    return updateJob(
      repoRoot,
      job.id,
      {
        enabled: false,
        lastRunAt: nowIso,
        lastStatus: status,
      },
      { now },
    );
  }

  // cron: catch-up once — next from `now`, not from the old nextRunAt chain
  const cronExpr = job.cronExpr?.trim();
  if (!cronExpr) {
    return updateJob(
      repoRoot,
      job.id,
      {
        enabled: false,
        lastRunAt: nowIso,
        lastStatus: "error",
      },
      { now },
    );
  }
  let nextRunAt: string;
  try {
    nextRunAt = computeNextRunAt({
      kind: "cron",
      cronExpr,
      from: now,
    });
  } catch {
    // Impossible cron — disable to avoid hot loop
    return updateJob(
      repoRoot,
      job.id,
      {
        enabled: false,
        lastRunAt: nowIso,
        lastStatus: "error",
      },
      { now },
    );
  }

  return updateJob(
    repoRoot,
    job.id,
    {
      nextRunAt,
      lastRunAt: nowIso,
      lastStatus: status,
    },
    { now },
  );
}

/**
 * One scheduler tick: discover due jobs, fire, persist status.
 * Safe to call concurrently only if the same fire callback serializes per slot;
 * this function itself processes jobs sequentially.
 */
export async function runScheduleTick(
  options: HostSchedulerOptions,
): Promise<TickResult> {
  const log = (options.log ?? silentLogger()).child("scheduler");
  const nowFn = options.now ?? (() => new Date());
  const now = nowFn();
  const result: TickResult = {
    scanned: Object.keys(options.repos).length,
    due: 0,
    fired: 0,
    busy: 0,
    errors: 0,
    skipped: 0,
  };

  const due = await collectDueJobs(options.repos, now);
  result.due = due.length;
  if (due.length === 0) return result;

  // Avoid double-firing the same job id within one tick (duplicate paths)
  const seen = new Set<string>();

  for (const item of due) {
    const { repoRoot, repoKey, job } = item;
    const key = `${repoRoot}::${job.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Re-read could race; use snapshot for fire, then write advance.
    const text = buildFireEnvelope(job, repoRoot);
    log.info("fire due job", {
      id: job.id,
      sessionKey: job.sessionKey,
      kind: job.kind,
      nextRunAt: job.nextRunAt,
      repoKey,
    });

    let fireResult: FireJobResult;
    try {
      fireResult = await options.fire({
        sessionKey: job.sessionKey,
        repoKey,
        repoRoot,
        text,
        job,
      });
    } catch (err) {
      fireResult = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (fireResult.status === "busy") {
      result.busy += 1;
      try {
        await updateJob(
          repoRoot,
          job.id,
          { lastStatus: "busy" },
          { now: nowFn() },
        );
      } catch (err) {
        log.warn("failed to mark busy", {
          id: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    if (fireResult.status === "skipped") {
      result.skipped += 1;
      try {
        await advanceAfterFire(repoRoot, job, "skipped", nowFn());
      } catch (err) {
        log.warn("failed to advance skipped job", {
          id: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    if (fireResult.status === "error") {
      result.errors += 1;
      log.warn("fire error", {
        id: job.id,
        error: fireResult.error,
      });
      try {
        // Advance schedule so we don't hot-loop on permanent ensure failures for once;
        // cron will retry next occurrence; once is disabled after attempt.
        await advanceAfterFire(repoRoot, job, "error", nowFn());
      } catch (err) {
        log.warn("failed to persist error status", {
          id: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // ok
    result.fired += 1;
    try {
      await advanceAfterFire(repoRoot, job, "ok", nowFn());
    } catch (err) {
      log.warn("failed to advance after ok fire", {
        id: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

export type SchedulerLoopHandle = {
  stop: () => void;
  /** Run one tick immediately (tests / schedule_run_now). */
  tickNow: () => Promise<TickResult>;
};

/**
 * Start interval loop. Does not fire immediately unless `fireImmediately`.
 */
export function startSchedulerLoop(
  options: HostSchedulerOptions & {
    tickMs?: number;
    fireImmediately?: boolean;
  },
): SchedulerLoopHandle {
  const log = (options.log ?? silentLogger()).child("scheduler");
  const tickMs = options.tickMs ?? DEFAULT_SCHEDULE_TICK_MS;
  let stopped = false;
  let running: Promise<void> | null = null;

  const tickNow = async (): Promise<TickResult> => {
    if (stopped) {
      return {
        scanned: 0,
        due: 0,
        fired: 0,
        busy: 0,
        errors: 0,
        skipped: 0,
      };
    }
    // Serialize ticks so a slow fire does not overlap the next interval.
    if (running) await running;
    let result: TickResult = {
      scanned: 0,
      due: 0,
      fired: 0,
      busy: 0,
      errors: 0,
      skipped: 0,
    };
    running = (async () => {
      try {
        result = await runScheduleTick(options);
        if (result.due > 0) {
          log.info("tick", result as unknown as Record<string, unknown>);
        } else {
          log.debug("tick empty", result as unknown as Record<string, unknown>);
        }
      } catch (err) {
        log.error("tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    await running;
    running = null;
    return result;
  };

  const timer = setInterval(() => {
    void tickNow();
  }, tickMs);
  // Don't keep process alive solely for scheduler in tests if unref'd — host wants it alive.
  if (typeof timer.unref === "function" && process.env.TACP_SCHEDULE_UNREF === "1") {
    timer.unref();
  }

  if (options.fireImmediately) {
    void tickNow();
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tickNow,
  };
}
