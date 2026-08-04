/**
 * Parent-linked multi-agent spawn registry.
 * Every child has immutable parentSessionKey + worktreePath + branch.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SpawnStatus =
  | "starting"
  | "idle"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "killed";

export type SpawnRecord = {
  runId: string;
  childSessionKey: string;
  /** Required parent host slotKey / sessionKey. */
  parentSessionKey: string;
  agent: string;
  role?: string;
  status: SpawnStatus;
  worktreePath: string;
  branch: string;
  baseRef: string;
  depth: number;
  createdAt: number;
  updatedAt: number;
  lastResultSummary?: string;
};

export type SpawnIndex = {
  byChild: Record<string, SpawnRecord>;
  byParent: Record<string, string[]>;
};

export function emptySpawnIndex(): SpawnIndex {
  return { byChild: {}, byParent: {} };
}

export function spawnRegistryPath(stateDir: string): string {
  return join(stateDir.replace(/\/$/, ""), "agent-spawns.json");
}

export async function loadSpawnIndex(stateDir: string): Promise<SpawnIndex> {
  const file = spawnRegistryPath(stateDir);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as SpawnIndex;
    if (!parsed?.byChild || !parsed?.byParent) return emptySpawnIndex();
    return parsed;
  } catch {
    return emptySpawnIndex();
  }
}

export async function saveSpawnIndex(
  stateDir: string,
  index: SpawnIndex,
): Promise<void> {
  const file = spawnRegistryPath(stateDir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

/** Validate child slug for session name suffix. */
export function validateChildSlug(slug: string): string {
  const s = slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(s)) {
    throw new Error(
      `invalid child name "${slug}" — use 1–32 chars [a-z0-9-] starting with alnum`,
    );
  }
  return s;
}

export function childSessionKey(
  parentSessionKey: string,
  slug: string,
): string {
  const s = validateChildSlug(slug);
  return `${parentSessionKey}--${s}`;
}

export function depthOfSessionKey(sessionKey: string): number {
  // root repo/name → 0; each --child adds depth
  const parts = sessionKey.split("--");
  return Math.max(0, parts.length - 1);
}

/**
 * Insert a spawn edge. Throws if child exists or parentSessionKey missing.
 */
export function addSpawnRecord(
  index: SpawnIndex,
  record: SpawnRecord,
): SpawnIndex {
  if (!record.parentSessionKey?.trim()) {
    throw new Error("parentSessionKey is required");
  }
  if (!record.childSessionKey?.trim()) {
    throw new Error("childSessionKey is required");
  }
  if (!record.worktreePath?.trim()) {
    throw new Error("worktreePath is required");
  }
  if (!record.branch?.trim()) {
    throw new Error("branch is required");
  }
  if (index.byChild[record.childSessionKey]) {
    throw new Error(`child already registered: ${record.childSessionKey}`);
  }
  const next: SpawnIndex = {
    byChild: { ...index.byChild, [record.childSessionKey]: record },
    byParent: { ...index.byParent },
  };
  const list = [...(next.byParent[record.parentSessionKey] ?? [])];
  if (!list.includes(record.childSessionKey)) list.push(record.childSessionKey);
  next.byParent[record.parentSessionKey] = list;
  return next;
}

export function removeSpawnRecord(
  index: SpawnIndex,
  childSessionKey: string,
): SpawnIndex {
  const rec = index.byChild[childSessionKey];
  if (!rec) return index;
  const byChild = { ...index.byChild };
  delete byChild[childSessionKey];
  const byParent = { ...index.byParent };
  const list = (byParent[rec.parentSessionKey] ?? []).filter(
    (k) => k !== childSessionKey,
  );
  if (list.length) byParent[rec.parentSessionKey] = list;
  else delete byParent[rec.parentSessionKey];
  return { byChild, byParent };
}

export function updateSpawnRecord(
  index: SpawnIndex,
  childSessionKey: string,
  patch: Partial<
    Pick<SpawnRecord, "status" | "lastResultSummary" | "updatedAt">
  >,
): SpawnIndex {
  const rec = index.byChild[childSessionKey];
  if (!rec) throw new Error(`unknown child: ${childSessionKey}`);
  const next = {
    ...rec,
    ...patch,
    updatedAt: patch.updatedAt ?? Date.now(),
  };
  return {
    byChild: { ...index.byChild, [childSessionKey]: next },
    byParent: index.byParent,
  };
}

export function listChildren(
  index: SpawnIndex,
  parentSessionKey: string,
): SpawnRecord[] {
  const keys = index.byParent[parentSessionKey] ?? [];
  return keys
    .map((k) => index.byChild[k])
    .filter((r): r is SpawnRecord => Boolean(r));
}

/**
 * Authorize A2A: parent may touch its children; child may touch parent; self ok.
 * Sibling mesh denied.
 */
export function authorizeAgentPeer(
  index: SpawnIndex,
  callerSessionKey: string,
  targetSessionKey: string,
): { ok: true } | { ok: false; error: string } {
  if (callerSessionKey === targetSessionKey) return { ok: true };
  const asChild = index.byChild[targetSessionKey];
  if (asChild && asChild.parentSessionKey === callerSessionKey) {
    return { ok: true };
  }
  const callerRec = index.byChild[callerSessionKey];
  if (callerRec && callerRec.parentSessionKey === targetSessionKey) {
    return { ok: true };
  }
  // target is "parent" literal resolved by caller
  return {
    ok: false,
    error: `not allowed to message ${targetSessionKey} from ${callerSessionKey} (parent hub only)`,
  };
}

/** Resolve to=slug|sessionKey|parent relative to caller. */
export function resolveAgentTarget(
  index: SpawnIndex,
  callerSessionKey: string,
  to: string,
): string {
  const t = to.trim();
  if (!t) throw new Error("target is required");
  if (t === "parent") {
    const rec = index.byChild[callerSessionKey];
    if (!rec) throw new Error("no parent — this session is not a spawned child");
    return rec.parentSessionKey;
  }
  if (index.byChild[t] || t.includes("/")) return t;
  // treat as slug under parent
  const candidate = `${callerSessionKey}--${t}`;
  if (index.byChild[candidate]) return candidate;
  return t;
}
