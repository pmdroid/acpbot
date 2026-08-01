/**
 * Durable ACP session records for the thin host.
 * Survives acpbot restarts so we can session/load when the agent supports it.
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type HostSessionRecord = {
  /** acpbot key: repo/name */
  sessionKey: string;
  /** ACP session id from session/new */
  agentSessionId: string;
  agent: string;
  cwd: string;
  modeId?: string;
  /** Last known LLM model id from ACP (session.models / _x.ai/models/update). */
  modelId?: string;
  createdAt: string;
  updatedAt: string;
};

export type HostSessionStore = {
  load(sessionKey: string): Promise<HostSessionRecord | undefined>;
  save(record: HostSessionRecord): Promise<void>;
  delete(sessionKey: string): Promise<void>;
  list(): Promise<HostSessionRecord[]>;
};

function fileNameFor(sessionKey: string): string {
  return `${encodeURIComponent(sessionKey)}.json`;
}

function isRecord(value: unknown): value is HostSessionRecord {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.sessionKey === "string" &&
    typeof o.agentSessionId === "string" &&
    typeof o.agent === "string" &&
    typeof o.cwd === "string" &&
    typeof o.createdAt === "string" &&
    typeof o.updatedAt === "string"
  );
}

/**
 * One JSON file per session under `<stateDir>/sessions/`.
 */
export function createFileHostSessionStore(stateDir: string): HostSessionStore {
  const dir = join(stateDir, "sessions");

  const ensureDir = async () => {
    await mkdir(dir, { recursive: true });
  };

  const pathFor = (sessionKey: string) => join(dir, fileNameFor(sessionKey));

  return {
    async load(sessionKey) {
      await ensureDir();
      try {
        const raw = await readFile(pathFor(sessionKey), "utf8");
        const parsed: unknown = JSON.parse(raw);
        return isRecord(parsed) ? parsed : undefined;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    },

    async save(record) {
      await ensureDir();
      const file = pathFor(record.sessionKey);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      const payload = `${JSON.stringify(record, null, 2)}\n`;
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, file);
    },

    async delete(sessionKey) {
      try {
        await unlink(pathFor(sessionKey));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },

    async list() {
      await ensureDir();
      const names = await readdir(dir);
      const out: HostSessionRecord[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(dir, name), "utf8");
          const parsed: unknown = JSON.parse(raw);
          if (isRecord(parsed)) out.push(parsed);
        } catch {
          /* skip corrupt */
        }
      }
      return out;
    },
  };
}

/** In-memory store for tests. */
export function createMemoryHostSessionStore(
  seed?: HostSessionRecord[],
): HostSessionStore {
  const map = new Map<string, HostSessionRecord>();
  for (const r of seed ?? []) map.set(r.sessionKey, structuredClone(r));
  return {
    async load(sessionKey) {
      const r = map.get(sessionKey);
      return r ? structuredClone(r) : undefined;
    },
    async save(record) {
      map.set(record.sessionKey, structuredClone(record));
    },
    async delete(sessionKey) {
      map.delete(sessionKey);
    },
    async list() {
      return [...map.values()].map((r) => structuredClone(r));
    },
  };
}
