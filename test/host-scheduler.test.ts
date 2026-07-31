/**
 * Host schedule ticker: fake clock + injectable fire callback.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildFireEnvelope,
  collectDueJobs,
  isJobDue,
  parseReposFromEnv,
  repoKeyFromSessionKey,
  runScheduleTick,
  scheduleTickMs,
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
      script: ".tacp/schedules/scripts/m.sh",
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
    expect(text).toContain("Path: .tacp/schedules/scripts/m.sh");
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
  test("fires once job, disables, records lastStatus ok", async () => {
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
      expect(job.enabled).toBe(true);

      const fires: string[] = [];
      let clock = new Date("2026-07-31T10:05:00.000Z");
      const tick = await runScheduleTick({
        repos: { life: repo },
        now: () => clock,
        fire: async ({ text, job: j }) => {
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

      // Second tick should not re-fire disabled once
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

  test("cron advances nextRunAt from now (catch-up once, no miss storm)", async () => {
    await withRepo(async (repo) => {
      // Every minute at :00 — overdue by hours
      const created = new Date("2026-07-31T08:00:00.000Z");
      const job = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "Minute tick work",
        kind: "cron",
        cronExpr: "0 * * * *", // top of every hour
        now: created,
      });
      // Force nextRunAt far in the past
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
          fireTimes.push(j.id);
          return { status: "ok" };
        },
      });

      expect(tick.fired).toBe(1);
      expect(fireTimes).toHaveLength(1);

      const after = await readJob(repo, job.id);
      expect(after?.enabled).toBe(true);
      expect(after?.lastStatus).toBe("ok");
      // Next occurrence strictly after now (12:30) → 13:00
      expect(after?.nextRunAt).toBe("2026-07-31T13:00:00.000Z");

      // Not due again until next hour
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

  test("busy slot marks lastStatus busy and retries next tick", async () => {
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
          return { status: "busy" };
        },
      });
      expect(tick1.busy).toBe(1);
      expect(tick1.fired).toBe(0);

      let after = await readJob(repo, job.id);
      expect(after?.enabled).toBe(true);
      expect(after?.lastStatus).toBe("busy");
      // nextRunAt unchanged so still due
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

  test("fire error still advances once/cron so we do not hot-loop", async () => {
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
        // Future job — not due
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
});
