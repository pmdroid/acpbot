/**
 * acp-host schedule ticker: scan catalog repos' `.acpbot/schedules/`, fire due jobs.
 *
 * Due = enabled && nextRunAt <= now.
 *
 * **Claim-before-fire** (crash-safe bookkeeping):
 * - once → disable on disk *before* calling fire (no double once on crash mid-turn)
 * - cron → advance nextRunAt from `now` *before* fire (catch-up once; no multi-miss storm)
 * - busy → claim is rolled back (restore enabled/nextRunAt), lastStatus=busy, retry next tick
 * - after fire → patch lastStatus (and lastRunAt if not set on claim)
 *
 * **Error tradeoff:** after a claim, ensure/spawn/`error` leaves the schedule advanced
 * (once stays disabled; cron waits for next occurrence). Prevents hot-loops on permanent
 * failures; recover once jobs via `schedule_run_now` / recreate. Transient blips are not
 * auto-retried until the next natural due (cron) or manual re-due (once).
 */
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import { computeNextRunAt } from "../schedules/next-run";
import { listJobs, readJob, updateJob } from "../schedules/store";
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
  /** repoKey → absolute path (from ACPBOT_REPOS_JSON / config). */
  repos: Record<string, string>;
  fire: ScheduleFireFn;
  /** Injectable clock (tests). */
  now?: () => Date;
  log?: Logger;
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

/** Parse ACPBOT_REPOS_JSON the same way as loadConfig (quote strip + JSON). */
export function parseReposFromEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const raw0 = env.ACPBOT_REPOS_JSON?.trim();
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
  const raw = env.ACPBOT_SCHEDULE_TICK_MS?.trim();
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
  log?: Logger,
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
      const skRepo = repoKeyFromSessionKey(job.sessionKey);
      if (skRepo != null && skRepo !== repoKey) {
        log?.warn("schedule sessionKey repo mismatch; skipping", {
          id: job.id,
          sessionKey: job.sessionKey,
          catalogRepoKey: repoKey,
          sessionRepoKey: skRepo,
        });
        continue;
      }
      due.push({ repoKey, repoRoot, job });
    }
  }
  due.sort((a, b) => a.job.nextRunAt.localeCompare(b.job.nextRunAt));
  return due;
}

/**
 * Advance schedule on disk before fire so a crash mid-turn cannot re-due the same run.
 * once → enabled false; cron → nextRunAt from now (catch-up once).
 */
export async function claimJobForFire(
  repoRoot: string,
  job: ScheduleJob,
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
      },
      { now },
    );
  }

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
    },
    { now },
  );
}

/** Undo claim when fire returns busy (slot mid-turn). */
async function rollbackClaim(
  repoRoot: string,
  preClaim: ScheduleJob,
  now: Date,
): Promise<ScheduleJob> {
  return updateJob(
    repoRoot,
    preClaim.id,
    {
      enabled: preClaim.enabled,
      nextRunAt: preClaim.nextRunAt,
      lastRunAt: preClaim.lastRunAt ?? null,
      lastStatus: "busy",
    },
    { now },
  );
}

async function patchFireStatus(
  repoRoot: string,
  jobId: string,
  status: ScheduleJobStatus,
  now: Date,
): Promise<ScheduleJob> {
  return updateJob(
    repoRoot,
    jobId,
    {
      lastStatus: status,
      lastRunAt: now.toISOString(),
    },
    { now },
  );
}

/**
 * One scheduler tick: discover due jobs, claim, fire, persist status.
 * Processes jobs sequentially.
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

  const due = await collectDueJobs(options.repos, now, log);
  result.due = due.length;
  if (due.length === 0) return result;

  const seen = new Set<string>();

  for (const item of due) {
    const { repoRoot, repoKey } = item;
    const key = `${repoRoot}::${item.job.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Re-read immediately before claim (cancel / concurrent update may have raced).
    let job: ScheduleJob;
    try {
      const fresh = await readJob(repoRoot, item.job.id);
      if (!fresh || !isJobDue(fresh, nowFn())) {
        result.skipped += 1;
        log.info("skip job no longer due", {
          id: item.job.id,
          reason: !fresh ? "missing" : "not-due",
        });
        continue;
      }
      job = fresh;
    } catch (err) {
      result.errors += 1;
      log.warn("re-read failed", {
        id: item.job.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const claimNow = nowFn();
    let claimed: ScheduleJob;
    try {
      claimed = await claimJobForFire(repoRoot, job, claimNow);
    } catch (err) {
      result.errors += 1;
      log.warn("claim failed; not firing", {
        id: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Broken cron claim disables the job with lastStatus error — do not fire.
    if (
      job.kind === "cron" &&
      claimed.enabled === false &&
      claimed.lastStatus === "error"
    ) {
      result.errors += 1;
      continue;
    }

    const text = buildFireEnvelope(job, repoRoot);
    log.info("fire due job (claimed)", {
      id: job.id,
      sessionKey: job.sessionKey,
      kind: job.kind,
      preClaimNextRunAt: job.nextRunAt,
      claimedNextRunAt: claimed.nextRunAt,
      claimedEnabled: claimed.enabled,
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

    const statusNow = nowFn();

    if (fireResult.status === "busy") {
      result.busy += 1;
      try {
        await rollbackClaim(repoRoot, job, statusNow);
      } catch (err) {
        log.warn("failed to rollback claim after busy", {
          id: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    if (fireResult.status === "skipped") {
      result.skipped += 1;
      try {
        await patchFireStatus(repoRoot, job.id, "skipped", statusNow);
      } catch (err) {
        log.warn("failed to patch skipped status", {
          id: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    if (fireResult.status === "error") {
      result.errors += 1;
      log.warn("fire error (schedule already claimed)", {
        id: job.id,
        error: fireResult.error,
      });
      try {
        await patchFireStatus(repoRoot, job.id, "error", statusNow);
      } catch (err) {
        log.warn("failed to patch error status", {
          id: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // ok — schedule already advanced on claim
    result.fired += 1;
    try {
      await patchFireStatus(repoRoot, job.id, "ok", statusNow);
    } catch (err) {
      // Claim already durable; status patch failure must not leave job re-due.
      log.warn("failed to patch ok status after claim (schedule already advanced)", {
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
  if (
    typeof timer.unref === "function" &&
    process.env.ACPBOT_SCHEDULE_UNREF === "1"
  ) {
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
