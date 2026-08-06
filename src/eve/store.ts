/**
 * Durable EVE run state under $stateDir/eve/runs/<runId>.json
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { EveBudgetState, EveMeta, EvePhaseStatus, EveRun } from "./types";

export function eveRunsDir(stateDir: string): string {
  return join(stateDir, "eve", "runs");
}

export function eveRunPath(stateDir: string, runId: string): string {
  return join(eveRunsDir(stateDir), `${runId}.json`);
}

export function eveRunScriptDir(stateDir: string, runId: string): string {
  return join(stateDir, "eve", "runs", runId);
}

export async function ensureEveDirs(stateDir: string): Promise<void> {
  await mkdir(eveRunsDir(stateDir), { recursive: true });
}

export function newRunId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

export function createEveRun(input: {
  runId?: string;
  name: string;
  sessionKey: string;
  repoKey: string;
  repoRoot: string;
  scriptPath: string;
  args?: unknown;
  meta: EveMeta;
  budget: EveBudgetState;
  status?: EveRun["status"];
  now?: number;
}): EveRun {
  const now = input.now ?? Date.now();
  const phases: EvePhaseStatus[] = (input.meta.phases ?? []).map((p) => ({
    title: p.title,
    status: "pending",
    agentCount: 0,
  }));
  return {
    runId: input.runId ?? newRunId(),
    name: input.name,
    sessionKey: input.sessionKey,
    repoKey: input.repoKey,
    repoRoot: input.repoRoot,
    status: input.status ?? "pending_approval",
    scriptPath: input.scriptPath,
    ...(input.args !== undefined ? { args: input.args } : {}),
    phases,
    nodes: {},
    resultCache: {},
    budget: input.budget,
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function saveEveRun(
  stateDir: string,
  run: EveRun,
): Promise<void> {
  await ensureEveDirs(stateDir);
  const path = eveRunPath(stateDir, run.runId);
  // Unique tmp per write — concurrent persist() must not share one .pid.tmp
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const next = { ...run, updatedAt: Date.now() };
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

export async function loadEveRun(
  stateDir: string,
  runId: string,
): Promise<EveRun | null> {
  try {
    const raw = await readFile(eveRunPath(stateDir, runId), "utf8");
    return JSON.parse(raw) as EveRun;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listEveRuns(
  stateDir: string,
  opts?: { sessionKey?: string; limit?: number },
): Promise<EveRun[]> {
  await ensureEveDirs(stateDir);
  const dir = eveRunsDir(stateDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const runs: EveRun[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const run = await loadEveRun(stateDir, name.replace(/\.json$/, ""));
    if (!run) continue;
    if (opts?.sessionKey && run.sessionKey !== opts.sessionKey) continue;
    runs.push(run);
  }
  runs.sort((a, b) => b.updatedAt - a.updatedAt);
  const limit = opts?.limit ?? 50;
  return runs.slice(0, limit);
}

export async function deleteEveRun(
  stateDir: string,
  runId: string,
): Promise<void> {
  await unlink(eveRunPath(stateDir, runId)).catch(() => {});
}

export function appendEveLog(run: EveRun, message: string): EveRun {
  const line = `[${new Date().toISOString()}] ${message}`;
  const logs = [...run.logs, line].slice(-200);
  return { ...run, logs, updatedAt: Date.now() };
}
