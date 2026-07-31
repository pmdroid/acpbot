/**
 * Atomic schedule job store under `<repoRoot>/.tacp/schedules/<id>.json`.
 *
 * - write: temp file + rename
 * - cancel: soft-disable (`enabled: false`)
 * - script paths must stay inside the repo (reject `..` escapes)
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { computeNextRunAt } from "./next-run";
import {
  scheduleJobSchema,
  type CreateScheduleInput,
  type ScheduleJob,
} from "./types";

/** Lexical containment (no realpath). */
export function isWithinRepo(repoRoot: string, candidate: string): boolean {
  const root = resolve(repoRoot);
  const abs = resolve(candidate);
  if (abs === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return abs.startsWith(prefix);
}

export function schedulesDir(repoRoot: string): string {
  return join(resolve(repoRoot), ".tacp", "schedules");
}

export function jobPath(repoRoot: string, id: string): string {
  assertSafeId(id);
  return join(schedulesDir(repoRoot), `${id}.json`);
}

export function assertSafeId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error(`invalid schedule id: ${id}`);
  }
  return trimmed;
}

/**
 * Validate script stays inside repo. Returns a normalized relative path for storage.
 * Rejects absolute paths and `..` escapes.
 */
export function normalizeScriptPath(repoRoot: string, script: string): string {
  const raw = script.trim();
  if (!raw) throw new Error("script path is empty");
  if (raw.includes("\0")) throw new Error("script path contains NUL");
  if (isAbsolute(raw)) {
    throw new Error(
      `script must be a path relative to repo root (got absolute: ${raw})`,
    );
  }
  // Normalize and resolve; reject escape.
  const root = resolve(repoRoot);
  const abs = resolve(root, raw);
  if (!isWithinRepo(root, abs)) {
    throw new Error(
      `script path escapes repo root: ${raw} → ${abs} (repo: ${root})`,
    );
  }
  // Store POSIX-ish relative (no leading ./)
  let rel = relative(root, abs);
  rel = rel.split(sep).join("/");
  if (!rel || rel === ".") {
    throw new Error(`script path must be a file inside the repo: ${raw}`);
  }
  if (rel.startsWith("..")) {
    throw new Error(`script path escapes repo root: ${raw}`);
  }
  return rel;
}

function newJobId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

async function writeJobAtomic(
  repoRoot: string,
  job: ScheduleJob,
): Promise<void> {
  const dir = schedulesDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const id = assertSafeId(job.id);
  const dest = join(dir, `${id}.json`);
  const tmp = join(
    dir,
    `.${id}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const body = `${JSON.stringify(job, null, 2)}\n`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, dest);
}

export async function readJob(
  repoRoot: string,
  id: string,
): Promise<ScheduleJob | null> {
  const safe = assertSafeId(id);
  const path = join(schedulesDir(repoRoot), `${safe}.json`);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = scheduleJobSchema.parse(JSON.parse(raw));
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function createJob(
  repoRoot: string,
  input: CreateScheduleInput,
): Promise<ScheduleJob> {
  const root = resolve(repoRoot);
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt is required");

  const sessionKey = input.sessionKey.trim();
  if (!sessionKey) throw new Error("sessionKey is required");

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  let script: string | undefined;
  if (input.script != null && input.script.trim() !== "") {
    script = normalizeScriptPath(root, input.script);
  }

  const nextRunAt = computeNextRunAt({
    kind: input.kind,
    from: now,
    ...(input.runAt != null ? { runAt: input.runAt } : {}),
    ...(input.cronExpr != null ? { cronExpr: input.cronExpr } : {}),
  });

  const id = newJobId();
  const job: ScheduleJob = {
    id,
    sessionKey,
    prompt,
    kind: input.kind,
    nextRunAt,
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (input.name != null && input.name.trim() !== "") {
    job.name = input.name.trim();
  }
  if (script != null) {
    job.script = script;
  }
  if (input.kind === "cron" && input.cronExpr?.trim()) {
    job.cronExpr = input.cronExpr.trim();
  }
  if (input.kind === "once" && input.runAt?.trim()) {
    job.runAt = new Date(input.runAt.trim()).toISOString();
  }
  if (input.timezone != null && input.timezone.trim() !== "") {
    job.timezone = input.timezone.trim();
  } else {
    job.timezone = "UTC";
  }

  // Re-validate full record before write
  const validated = scheduleJobSchema.parse(job);
  await writeJobAtomic(root, validated);
  return validated;
}

export type ListJobsOptions = {
  /** When set and `all` is not true, only jobs for this session. */
  sessionKey?: string;
  /** List every job in the repo (ignore session filter). */
  all?: boolean;
};

export async function listJobs(
  repoRoot: string,
  opts: ListJobsOptions = {},
): Promise<ScheduleJob[]> {
  const dir = schedulesDir(repoRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const out: ScheduleJob[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name.startsWith(".")) continue;
    const id = name.slice(0, -".json".length);
    try {
      assertSafeId(id);
    } catch {
      continue;
    }
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const job = scheduleJobSchema.parse(JSON.parse(raw));
      if (!opts.all && opts.sessionKey) {
        if (job.sessionKey !== opts.sessionKey) continue;
      }
      out.push(job);
    } catch {
      // skip corrupt / non-job files
      continue;
    }
  }

  out.sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  return out;
}

/**
 * Soft-cancel: set enabled=false. History and script path remain on disk.
 */
export async function cancelJob(
  repoRoot: string,
  id: string,
): Promise<ScheduleJob> {
  const root = resolve(repoRoot);
  const existing = await readJob(root, id);
  if (!existing) {
    throw new Error(`schedule not found: ${id}`);
  }
  if (!existing.enabled) {
    return existing;
  }
  const updated: ScheduleJob = {
    ...existing,
    enabled: false,
    updatedAt: new Date().toISOString(),
  };
  const validated = scheduleJobSchema.parse(updated);
  await writeJobAtomic(root, validated);
  return validated;
}
