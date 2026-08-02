import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeNextRunAt,
  nextCronOccurrence,
  parseCronExpr,
} from "../src/schedules/next-run";
import {
  cancelJob,
  createJob,
  jobPath,
  listJobs,
  markJobDue,
  normalizeScriptPath,
  readJob,
  schedulesDir,
  updateJob,
} from "../src/schedules/store";
import { scheduleJobSchema } from "../src/schedules/types";

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "acpbot-sched-"));
}

describe("schedules next-run", () => {
  test("once uses runAt ISO", () => {
    const iso = "2026-08-01T12:00:00.000Z";
    expect(computeNextRunAt({ kind: "once", runAt: iso })).toBe(iso);
  });

  test("once requires runAt", () => {
    expect(() => computeNextRunAt({ kind: "once" })).toThrow(/runAt/);
  });

  test("cron requires cronExpr", () => {
    expect(() => computeNextRunAt({ kind: "cron" })).toThrow(/cronExpr/);
  });

  test("cron 0 * * * * is next top of hour after from", () => {
    const from = new Date("2026-08-01T10:15:30.000Z");
    const next = nextCronOccurrence("0 * * * *", from);
    expect(next.toISOString()).toBe("2026-08-01T11:00:00.000Z");
  });

  test("cron 30 8 * * 1-5 weekday 08:30 UTC", () => {
    // Saturday 2026-08-01
    const from = new Date("2026-08-01T00:00:00.000Z");
    const next = nextCronOccurrence("30 8 * * 1-5", from);
    // Next Mon 2026-08-03 08:30
    expect(next.toISOString()).toBe("2026-08-03T08:30:00.000Z");
  });

  test("cron DOM+DOW both restricted uses OR (classic Vixie)", () => {
    // 0 9 15 * 1 = 09:00 on the 15th OR on Mondays
    // from Sat 2026-08-01 → next Monday 2026-08-03 09:00 (not next 15th that is Monday)
    const from = new Date("2026-08-01T00:00:00.000Z");
    const next = nextCronOccurrence("0 9 15 * 1", from);
    expect(next.toISOString()).toBe("2026-08-03T09:00:00.000Z");
    expect(next.getUTCDay()).toBe(1); // Monday
  });

  test("cron DOM-only still requires that day-of-month", () => {
    // 0 9 15 * * — next 15th at 09:00 from Aug 1 → Aug 15
    const from = new Date("2026-08-01T00:00:00.000Z");
    const next = nextCronOccurrence("0 9 15 * *", from);
    expect(next.toISOString()).toBe("2026-08-15T09:00:00.000Z");
  });

  test("cron exclusive lower bound skips exact match minute", () => {
    const from = new Date("2026-08-01T11:00:00.000Z");
    const next = nextCronOccurrence("0 * * * *", from);
    expect(next.toISOString()).toBe("2026-08-01T12:00:00.000Z");
  });

  test("cron Sunday 7 synonym", () => {
    // 2026-08-01 is Saturday; next Sunday is 2026-08-02
    const from = new Date("2026-08-01T00:00:00.000Z");
    const next = nextCronOccurrence("0 10 * * 7", from);
    expect(next.toISOString()).toBe("2026-08-02T10:00:00.000Z");
    expect(next.getUTCDay()).toBe(0);
  });

  test("parseCronExpr rejects wrong field count", () => {
    expect(() => parseCronExpr("* * *")).toThrow(/5 fields/);
  });
});

describe("schedules store CRUD", () => {
  test("create once job writes atomic JSON with prompt", async () => {
    const repo = await tempRepo();
    try {
      const runAt = "2026-09-01T09:00:00.000Z";
      const job = await createJob(repo, {
        sessionKey: "life/main",
        name: "one-shot",
        prompt: "Do the thing once.",
        kind: "once",
        runAt,
      });

      expect(job.id).toMatch(/^[a-f0-9]{12}$/);
      expect(job.prompt).toBe("Do the thing once.");
      expect(job.enabled).toBe(true);
      expect(job.nextRunAt).toBe(runAt);
      expect(job.runAt).toBe(runAt);
      expect(job.sessionKey).toBe("life/main");
      expect(job.kind).toBe("once");
      expect(job.timezone).toBe("UTC");

      const onDisk = JSON.parse(
        await readFile(jobPath(repo, job.id), "utf8"),
      );
      expect(scheduleJobSchema.parse(onDisk).prompt).toBe("Do the thing once.");
      expect(onDisk.script).toBeUndefined();
      // final path is .json not .tmp
      expect(jobPath(repo, job.id).endsWith(`${job.id}.json`)).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("create cron job with optional script path", async () => {
    const repo = await tempRepo();
    try {
      const from = new Date("2026-08-01T10:00:00.000Z");
      const job = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "Run backup and report.",
        script: ".acpbot/schedules/scripts/backup.sh",
        kind: "cron",
        cronExpr: "0 3 * * *",
        now: from,
      });

      expect(job.script).toBe(".acpbot/schedules/scripts/backup.sh");
      expect(job.cronExpr).toBe("0 3 * * *");
      expect(job.nextRunAt).toBe("2026-08-02T03:00:00.000Z");

      const listed = await listJobs(repo, { sessionKey: "life/main" });
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe(job.id);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("prompt is required (empty rejected)", async () => {
    const repo = await tempRepo();
    try {
      await expect(
        createJob(repo, {
          sessionKey: "life/main",
          prompt: "   ",
          kind: "once",
          runAt: "2026-09-01T00:00:00.000Z",
        }),
      ).rejects.toThrow(/prompt/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("script path with .. is rejected", async () => {
    const repo = await tempRepo();
    try {
      await expect(
        normalizeScriptPath(repo, "../../etc/passwd"),
      ).rejects.toThrow(/escapes/);

      await expect(
        createJob(repo, {
          sessionKey: "life/main",
          prompt: "evil",
          script: "foo/../../../etc/passwd",
          kind: "once",
          runAt: "2026-09-01T00:00:00.000Z",
        }),
      ).rejects.toThrow(/escapes|repo/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("absolute script path is rejected", async () => {
    const repo = await tempRepo();
    try {
      await expect(normalizeScriptPath(repo, "/tmp/x.sh")).rejects.toThrow(
        /relative/,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("script symlink outside repo is rejected when target exists", async () => {
    const repo = await tempRepo();
    const outside = await tempRepo();
    try {
      const secret = join(outside, "secret.sh");
      await writeFile(secret, "#!/bin/sh\n", "utf8");
      await mkdir(join(repo, "scripts"), { recursive: true });
      const link = join(repo, "scripts", "evil.sh");
      await symlink(secret, link);
      await expect(
        normalizeScriptPath(repo, "scripts/evil.sh"),
      ).rejects.toThrow(/outside|symlink/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("cancel soft-disables (enabled false, file remains)", async () => {
    const repo = await tempRepo();
    try {
      const job = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "will cancel",
        kind: "once",
        runAt: "2026-10-01T00:00:00.000Z",
      });

      const cancelled = await cancelJob(repo, job.id, {
        sessionKey: "life/main",
      });
      expect(cancelled.enabled).toBe(false);
      expect(cancelled.prompt).toBe("will cancel");

      const again = await readJob(repo, job.id);
      expect(again?.enabled).toBe(false);

      const raw = await readFile(jobPath(repo, job.id), "utf8");
      expect(JSON.parse(raw).enabled).toBe(false);

      // idempotent
      const second = await cancelJob(repo, job.id, {
        sessionKey: "life/main",
      });
      expect(second.enabled).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("cancel is scoped to sessionKey by default", async () => {
    const repo = await tempRepo();
    try {
      const other = await createJob(repo, {
        sessionKey: "life/other",
        prompt: "other session job",
        kind: "once",
        runAt: "2026-12-01T00:00:00.000Z",
      });

      await expect(
        cancelJob(repo, other.id, { sessionKey: "life/main" }),
      ).rejects.toThrow(/belongs to session|not life\/main/);

      // still enabled
      expect((await readJob(repo, other.id))?.enabled).toBe(true);

      // own session can cancel
      const mine = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "mine",
        kind: "once",
        runAt: "2026-12-02T00:00:00.000Z",
      });
      const cancelled = await cancelJob(repo, mine.id, {
        sessionKey: "life/main",
      });
      expect(cancelled.enabled).toBe(false);

      // all=true can cancel other session's job
      const forced = await cancelJob(repo, other.id, { all: true });
      expect(forced.enabled).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("cancel without sessionKey or all throws", async () => {
    const repo = await tempRepo();
    try {
      const job = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "x",
        kind: "once",
        runAt: "2026-12-03T00:00:00.000Z",
      });
      await expect(cancelJob(repo, job.id)).rejects.toThrow(/sessionKey/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("list filters by sessionKey; all lists every job", async () => {
    const repo = await tempRepo();
    try {
      await createJob(repo, {
        sessionKey: "life/main",
        prompt: "a",
        kind: "once",
        runAt: "2026-11-01T00:00:00.000Z",
      });
      await createJob(repo, {
        sessionKey: "life/other",
        prompt: "b",
        kind: "once",
        runAt: "2026-11-02T00:00:00.000Z",
      });

      const mainOnly = await listJobs(repo, { sessionKey: "life/main" });
      expect(mainOnly).toHaveLength(1);
      expect(mainOnly[0]!.prompt).toBe("a");

      const all = await listJobs(repo, { all: true });
      expect(all).toHaveLength(2);

      await expect(listJobs(repo, {})).rejects.toThrow(/sessionKey/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("cancel missing id throws", async () => {
    const repo = await tempRepo();
    try {
      await expect(
        cancelJob(repo, "deadbeefcafe", { sessionKey: "life/main" }),
      ).rejects.toThrow(/not found/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("markJobDue is session-scoped; all bypasses; unscoped throws", async () => {
    const repo = await tempRepo();
    try {
      const other = await createJob(repo, {
        sessionKey: "life/other",
        prompt: "other",
        kind: "once",
        runAt: "2026-12-01T00:00:00.000Z",
      });
      await expect(
        markJobDue(repo, other.id, { sessionKey: "life/main" }),
      ).rejects.toThrow(/belongs to session|not life\/main/);
      await expect(markJobDue(repo, other.id)).rejects.toThrow(/sessionKey/);

      const now = new Date("2026-07-31T12:00:00.000Z");
      const forced = await markJobDue(repo, other.id, { all: true, now });
      expect(forced.enabled).toBe(true);
      expect(forced.nextRunAt).toBe(now.toISOString());

      const mine = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "mine",
        kind: "once",
        runAt: "2026-12-02T00:00:00.000Z",
      });
      await updateJob(repo, mine.id, { enabled: false }, { now });
      const due = await markJobDue(repo, mine.id, {
        sessionKey: "life/main",
        now,
      });
      expect(due.enabled).toBe(true);
      expect(due.nextRunAt).toBe(now.toISOString());
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("updateJob patches lastStatus and nextRunAt", async () => {
    const repo = await tempRepo();
    try {
      const job = await createJob(repo, {
        sessionKey: "life/main",
        prompt: "x",
        kind: "once",
        runAt: "2026-12-03T00:00:00.000Z",
      });
      const now = new Date("2026-07-31T15:00:00.000Z");
      const updated = await updateJob(
        repo,
        job.id,
        {
          lastStatus: "busy",
          lastRunAt: now.toISOString(),
          nextRunAt: "2026-07-31T14:00:00.000Z",
        },
        { now },
      );
      expect(updated.lastStatus).toBe("busy");
      expect(updated.nextRunAt).toBe("2026-07-31T14:00:00.000Z");
      expect((await readJob(repo, job.id))?.lastStatus).toBe("busy");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("schedulesDir is under .acpbot/schedules", async () => {
    const repo = await tempRepo();
    expect(schedulesDir(repo)).toBe(join(repo, ".acpbot", "schedules"));
  });
});

/**
 * MCP tool surface: exercise the same env + store path the server uses.
 * (Full FastMCP stdio handshake is out of scope; handlers are thin wrappers.)
 */
describe("schedule MCP env + store path", () => {
  test("create/list/cancel via store with ACPBOT-style env context", async () => {
    const repo = await tempRepo();
    const sessionKey = "demo/topic";
    const prevKey = process.env.ACPBOT_SESSION_KEY;
    const prevRoot = process.env.ACPBOT_REPO_ROOT;
    process.env.ACPBOT_SESSION_KEY = sessionKey;
    process.env.ACPBOT_REPO_ROOT = repo;
    try {
      const envSession = process.env.ACPBOT_SESSION_KEY!.trim();
      const envRoot = process.env.ACPBOT_REPO_ROOT!.trim();

      const created = await createJob(envRoot, {
        sessionKey: envSession,
        prompt: "MCP path job",
        kind: "cron",
        cronExpr: "15 6 * * *",
        now: new Date("2026-08-01T00:00:00.000Z"),
      });
      expect(created.sessionKey).toBe(sessionKey);

      const listed = await listJobs(envRoot, { sessionKey: envSession });
      expect(listed.some((j) => j.id === created.id)).toBe(true);

      const cancelled = await cancelJob(envRoot, created.id, {
        sessionKey: envSession,
      });
      expect(cancelled.enabled).toBe(false);
    } finally {
      if (prevKey === undefined) delete process.env.ACPBOT_SESSION_KEY;
      else process.env.ACPBOT_SESSION_KEY = prevKey;
      if (prevRoot === undefined) delete process.env.ACPBOT_REPO_ROOT;
      else process.env.ACPBOT_REPO_ROOT = prevRoot;
      await rm(repo, { recursive: true, force: true });
    }
  });
});
