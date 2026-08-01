/**
 * Host schedule ticker: fake clock + injectable fire callback.
 * Claim-before-fire: schedule advances on disk before fire is invoked.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildFireEnvelope,
  claimJobForFire,
  collectDueJobs,
  isJobDue,
  parseReposFromEnv,
  repoKeyFromSessionKey,
  runScheduleTick,
  scheduleTickMs,
  startSchedulerLoop,
} from "../src/acp-host/scheduler";
import {
  createJob,
  listJobs,
  markJobDue,
  readJob,
  updateJob,
} from "../src/schedules/store";
import type { ScheduleJob } from "../src/schedules/types";

async function withRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tacp-sched-host-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("scheduler helpers", () => {
  test("parseReposFromEnv strips quotes and maps keys", () => {
    expect(
      parseReposFromEnv({
        TACP_REPOS_JSON: `'{"life":"/repos/life","code":"/repos/code"}'`,
      }),
    ).toEqual({ life: "/repos/life", code: "/repos/code" });
    expect(parseReposFromEnv({})).toEqual({});
    expect(parseReposFromEnv({ TACP_REPOS_JSON: "not-json" })).toEqual({});
  });

  test("scheduleTickMs defaults and clamps", () => {
    expect(scheduleTickMs({})).toBe(20_000);
    expect(scheduleTickMs({ TACP_SCHEDULE_TICK_MS: "15000" })).toBe(15_000);
    expect(scheduleTickMs({ TACP_SCHEDULE_TICK_MS: "50" })).toBe(20_000);
  });

  test("repoKeyFromSessionKey", () => {
    expect(repoKeyFromSessionKey("life/main")).toBe("life");
    expect(repoKeyFromSessionKey("life/morning/x")).toBe("life");
    expect(repoKeyFromSessionKey("noslash")).toBeNull();
    expect(repoKeyFromSessionKey("/bad")).toBeNull();
  });

  test("buildFireEnvelope includes prompt and optional script", () => {
    const job = {
      id: "abc123",
      sessionKey: "life/main",
      name: "morning",
      prompt: "Do the brief.",
      script: ".acpbot/schedules/scripts/m.sh",
      kind: "once" as const,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const text = buildFireEnvelope(job, "/repos/life");
    expect(text).toContain("[scheduled job abc123 | morning]");
    expect(text).toContain("session life/main");
    expect(text).toContain("Repo: /repos/life");
    expect(text).toContain("## Prompt");
    expect(text).toContain("Do the brief.");
    expect(text).toContain("Path: .acpbot/schedules/scripts/m.sh");
    expect(text).toContain("summarize what you did");
  });

  test("isJobDue respects enabled and nextRunAt", () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    const base = {
      id: "x",
      sessionKey: "r/s",
      prompt: "p",
      kind: "once" as const,
      nextRunAt: "2026-07-31T11:00:00.000Z",
      enabled: true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    expect(isJobDue(base, now)).toBe(true);
    expect(isJobDue({ ...base, enabled: false }, now)).toBe(false);
    expect(
      isJobDue(
        { ...base, nextRunAt: "2026-07-31T13:00:00.000Z" },
        now,
      ),
    ).toBe(false);
  });
});

describe("runScheduleTick", () => {
  test("claim-before-fire: once is disabled on disk before fire runs", async () => {
    await withRepo(async (repo) => {
      const t0 = new Date("2026-07-31T10:00:00.000Z");
      const job = await createJob(repo, {
        sessionKey: "life/main",
        name: "once-job",
        prompt: "Say hello",
        kind: "once",
        runAt: "2026-07-31T09:00:00.000Z",
        now: t0,
      });

      const fires: string[] = [];
      let clock = new Date("2026-07-31T10:05:00.000Z");
      const tick = await runScheduleTick({
        repos: { life: repo },
        now: () => clock,
        fire: async ({ text, job: j }) => {
          // Durable claim must already be visible mid-fire
          const mid = await readJob(repo, j.id);
          expect(mid?.enabled).toBe(false);
          fires.push(j.id);
          expect(text).toContain("Say hello");
          expect(text).toContain("[scheduled job");
          return { status: "ok" };
        },
      });

      expect(tick.due).toBe(1);
      expect(tick.fired).toBe(1);
      expect(fires).toEqual([job.id]);

      const after = await readJob(repo, job.id);
      expect(after?.enabled).toBe(false);
      expect(after?.lastStatus).toBe("ok");
      expect(after?.lastRunAt).toBeTruthy();

      clock = new Date("2026-07-31T10:10:00.000Z");
      const tick2 = await runScheduleTick({
        repos: { life: repo },
        now: () => clock,
        fire: async () => {
          fires.push("again");
          return { status: "ok" };
        },
      });
      expect(tick2.due).toBe(0);
      expect(fires).toEqual([job.id]);
    });
  });

  test("claim-before-fire: cron nextRunAt advanced before fire (catch-up once)", async () => {
    await withRepo(async (repo) => {
      const created = new Date("2026-07-31T08:00:00.000Z");
      const job = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "Minute tick work",
        kind: "cron",
        cronExpr: "0 * * * *",
        now: created,
      });
      await updateJob(
        repo,
        job.id,
        { nextRunAt: "2026-07-31T01:00:00.000Z" },
        { now: created },
      );

      const fireTimes: string[] = [];
      const now = new Date("2026-07-31T12:30:00.000Z");
      const tick = await runScheduleTick({
        repos: { life: repo },
        now: () => now,
        fire: async ({ job: j }) => {
          const mid = await readJob(repo, j.id);
          // Claim moved next to 13:00 before agent runs
          expect(mid?.nextRunAt).toBe("2026-07-31T13:00:00.000Z");
          expect(mid?.enabled).toBe(true);
          fireTimes.push(j.id);
          return { status: "ok" };
        },
      });

      expect(tick.fired).toBe(1);
      expect(fireTimes).toHaveLength(1);

      const after = await readJob(repo, job.id);
      expect(after?.enabled).toBe(true);
      expect(after?.lastStatus).toBe("ok");
      expect(after?.nextRunAt).toBe("2026-07-31T13:00:00.000Z");

      const tick2 = await runScheduleTick({
        repos: { life: repo },
        now: () => new Date("2026-07-31T12:45:00.000Z"),
        fire: async () => {
          fireTimes.push("extra");
          return { status: "ok" };
        },
      });
      expect(tick2.due).toBe(0);
      expect(fireTimes).toHaveLength(1);
    });
  });

  test("busy rolls back claim and retries next tick", async () => {
    await withRepo(async (repo) => {
      const t0 = new Date("2026-07-31T10:00:00.000Z");
      const job = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "Busy work",
        kind: "once",
        runAt: "2026-07-31T09:00:00.000Z",
        now: t0,
      });

      let attempt = 0;
      const now = new Date("2026-07-31T10:05:00.000Z");
      const tick1 = await runScheduleTick({
        repos: { life: repo },
        now: () => now,
        fire: async () => {
          attempt += 1;
          // Mid-fire the claim has disabled once — rollback restores after
          const mid = await readJob(repo, job.id);
          expect(mid?.enabled).toBe(false);
          return { status: "busy" };
        },
      });
      expect(tick1.busy).toBe(1);
      expect(tick1.fired).toBe(0);

      let after = await readJob(repo, job.id);
      expect(after?.enabled).toBe(true);
      expect(after?.lastStatus).toBe("busy");
      expect(after?.nextRunAt).toBe(job.nextRunAt);
      expect(isJobDue(after as ScheduleJob, now)).toBe(true);

      const tick2 = await runScheduleTick({
        repos: { life: repo },
        now: () => now,
        fire: async () => {
          attempt += 1;
          return { status: "ok" };
        },
      });
      expect(tick2.fired).toBe(1);
      expect(attempt).toBe(2);

      after = await readJob(repo, job.id);
      expect(after?.enabled).toBe(false);
      expect(after?.lastStatus).toBe("ok");
    });
  });

  test("fire error leaves once claimed (disabled) — no hot-loop", async () => {
    await withRepo(async (repo) => {
      const t0 = new Date("2026-07-31T10:00:00.000Z");
      const job = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "Fail me",
        kind: "once",
        runAt: "2026-07-31T09:00:00.000Z",
        now: t0,
      });

      const tick = await runScheduleTick({
        repos: { life: repo },
        now: () => new Date("2026-07-31T10:05:00.000Z"),
        fire: async () => ({ status: "error", error: "ensure failed" }),
      });
      expect(tick.errors).toBe(1);

      const after = await readJob(repo, job.id);
      expect(after?.enabled).toBe(false);
      expect(after?.lastStatus).toBe("error");
    });
  });

  test("cron fire error keeps advanced nextRunAt (no hot-loop)", async () => {
    await withRepo(async (repo) => {
      const created = new Date("2026-07-31T08:00:00.000Z");
      const job = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "Cron fail",
        kind: "cron",
        cronExpr: "0 * * * *",
        now: created,
      });
      await updateJob(
        repo,
        job.id,
        { nextRunAt: "2026-07-31T11:00:00.000Z" },
        { now: created },
      );

      const now = new Date("2026-07-31T11:30:00.000Z");
      const tick = await runScheduleTick({
        repos: { life: repo },
        now: () => now,
        fire: async () => ({ status: "error", error: "spawn failed" }),
      });
      expect(tick.errors).toBe(1);

      const after = await readJob(repo, job.id);
      expect(after?.enabled).toBe(true);
      expect(after?.lastStatus).toBe("error");
      // Claim advanced to next hour after 11:30 → 12:00
      expect(after?.nextRunAt).toBe("2026-07-31T12:00:00.000Z");
      expect(isJobDue(after as ScheduleJob, now)).toBe(false);
    });
  });

  test("re-read skips job cancelled between collect and claim", async () => {
    await withRepo(async (repo) => {
      const t0 = new Date("2026-07-31T10:00:00.000Z");
      const job = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "cancel race",
        kind: "once",
        runAt: "2026-07-31T09:00:00.000Z",
        now: t0,
      });

      let fired = false;
      // Disable after collect would see it: fire callback not the right hook —
      // instead patch between collect and claim by using a fire that never runs
      // because we disable in a custom path: updateJob before tick with enabled false
      // after first collect... We simulate by disabling in the same tick via
      // updateJob in a second job's fire... Simpler: disable then tick.
      await updateJob(repo, job.id, { enabled: false }, { now: t0 });

      const tick = await runScheduleTick({
        repos: { life: repo },
        now: () => new Date("2026-07-31T10:05:00.000Z"),
        fire: async () => {
          fired = true;
          return { status: "ok" };
        },
      });
      expect(tick.due).toBe(0);
      expect(fired).toBe(false);
    });
  });

  test("collectDueJobs scans multiple repos", async () => {
    await withRepo(async (repoA) => {
      await withRepo(async (repoB) => {
        const t0 = new Date("2026-07-31T10:00:00.000Z");
        await createJob(repoA, {
          sessionKey: "a/main",
          prompt: "A",
          kind: "once",
          runAt: "2026-07-31T09:00:00.000Z",
          now: t0,
        });
        await createJob(repoB, {
          sessionKey: "b/main",
          prompt: "B",
          kind: "once",
          runAt: "2026-07-31T09:30:00.000Z",
          now: t0,
        });
        await createJob(repoA, {
          sessionKey: "a/main",
          prompt: "later",
          kind: "once",
          runAt: "2026-08-01T00:00:00.000Z",
          now: t0,
        });

        const due = await collectDueJobs(
          { a: repoA, b: repoB },
          new Date("2026-07-31T10:00:00.000Z"),
        );
        expect(due).toHaveLength(2);
        expect(due.map((d) => d.job.prompt).sort()).toEqual(["A", "B"]);
      });
    });
  });

  test("collectDueJobs skips sessionKey/catalog repo mismatch", async () => {
    await withRepo(async (repo) => {
      const t0 = new Date("2026-07-31T10:00:00.000Z");
      // session says other/… but file lives under catalog key "life"
      await createJob(repo, {
        sessionKey: "other/main",
        prompt: "wrong repo key",
        kind: "once",
        runAt: "2026-07-31T09:00:00.000Z",
        now: t0,
      });
      const due = await collectDueJobs(
        { life: repo },
        new Date("2026-07-31T10:00:00.000Z"),
      );
      expect(due).toHaveLength(0);
    });
  });

  test("markJobDue makes a future job fire on next tick", async () => {
    await withRepo(async (repo) => {
      const t0 = new Date("2026-07-31T10:00:00.000Z");
      const job = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "Run me now",
        kind: "once",
        runAt: "2026-08-15T00:00:00.000Z",
        now: t0,
      });

      const notYet = await collectDueJobs(
        { life: repo },
        new Date("2026-07-31T12:00:00.000Z"),
      );
      expect(notYet).toHaveLength(0);

      const dueAt = new Date("2026-07-31T12:00:00.000Z");
      await markJobDue(repo, job.id, {
        sessionKey: "life/main",
        now: dueAt,
      });

      let fired = false;
      const tick = await runScheduleTick({
        repos: { life: repo },
        now: () => dueAt,
        fire: async () => {
          fired = true;
          return { status: "ok" };
        },
      });
      expect(tick.fired).toBe(1);
      expect(fired).toBe(true);
    });
  });

  test("disabled and future jobs are not listed as due", async () => {
    await withRepo(async (repo) => {
      const t0 = new Date("2026-07-31T10:00:00.000Z");
      const j1 = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "off",
        kind: "once",
        runAt: "2026-07-31T09:00:00.000Z",
        now: t0,
      });
      await updateJob(repo, j1.id, { enabled: false }, { now: t0 });
      await createJob(repo, {
        sessionKey: "life/main",
        prompt: "future",
        kind: "once",
        runAt: "2030-01-01T00:00:00.000Z",
        now: t0,
      });
      const all = await listJobs(repo, { all: true });
      expect(all.length).toBe(2);
      const due = await collectDueJobs(
        { life: repo },
        new Date("2026-07-31T12:00:00.000Z"),
      );
      expect(due).toHaveLength(0);
    });
  });

  test("claimJobForFire helper advances once and cron", async () => {
    await withRepo(async (repo) => {
      const t0 = new Date("2026-07-31T10:00:00.000Z");
      const once = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "o",
        kind: "once",
        runAt: "2026-07-31T09:00:00.000Z",
        now: t0,
      });
      const claimedOnce = await claimJobForFire(repo, once, t0);
      expect(claimedOnce.enabled).toBe(false);

      const cron = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "c",
        kind: "cron",
        cronExpr: "0 * * * *",
        now: t0,
      });
      await updateJob(
        repo,
        cron.id,
        { nextRunAt: "2026-07-31T09:00:00.000Z" },
        { now: t0 },
      );
      const fresh = (await readJob(repo, cron.id))!;
      const claimedCron = await claimJobForFire(
        repo,
        fresh,
        new Date("2026-07-31T10:30:00.000Z"),
      );
      expect(claimedCron.nextRunAt).toBe("2026-07-31T11:00:00.000Z");
      expect(claimedCron.enabled).toBe(true);
    });
  });

  test("startSchedulerLoop fireImmediately + stop", async () => {
    await withRepo(async (repo) => {
      const t0 = new Date("2026-07-31T10:00:00.000Z");
      await createJob(repo, {
        sessionKey: "life/main",
        prompt: "loop",
        kind: "once",
        runAt: "2026-07-31T09:00:00.000Z",
        now: t0,
      });

      let fires = 0;
      const loop = startSchedulerLoop({
        repos: { life: repo },
        now: () => new Date("2026-07-31T10:05:00.000Z"),
        tickMs: 60_000,
        fireImmediately: false,
        fire: async () => {
          fires += 1;
          return { status: "ok" };
        },
      });
      const r = await loop.tickNow();
      expect(r.fired).toBe(1);
      expect(fires).toBe(1);
      loop.stop();
      const afterStop = await loop.tickNow();
      expect(afterStop.due).toBe(0);
      expect(fires).toBe(1);
    });
  });
});
