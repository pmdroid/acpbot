/**
 * Durable ACP session records for the thin host.
 * Survives acpbot restarts so we can session/load when the agent supports it.
 *
 * Writes are atomic (unique tmp + fsync + rename) and serialized per sessionKey
 * so concurrent saves cannot clobber each other mid-write (a past race left
 * trailing NULs and broke ensureSession with JSON parse errors).
 */
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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

/** Strip NULs / BOM and parse; used for recovery from interrupted writes. */
export function parseSessionRecordJson(
  raw: string,
): HostSessionRecord | undefined {
  const cleaned = raw.replace(/\u0000/g, "").replace(/^\uFEFF/, "").trim();
  if (!cleaned) return undefined;
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // Truncated JSON often still has a last complete-ish object attempt —
    // do not invent fields; fail closed to undefined.
    return undefined;
  }
}

/**
 * Write payload to dest via unique temp + fsync + rename.
 * Safe against process kill mid-write (dest stays previous good content).
 */
export async function atomicWriteFile(
  dest: string,
  payload: string,
): Promise<void> {
  const uniq = `${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString("hex")}`;
  const tmp = `${dest}.${uniq}.tmp`;
  try {
    const fh = await open(tmp, "w", 0o644);
    try {
      await fh.writeFile(payload, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, dest);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/**
 * One JSON file per session under `<stateDir>/sessions/`.
 */
export function createFileHostSessionStore(stateDir: string): HostSessionStore {
  const dir = join(stateDir, "sessions");
  /** Serialize save/delete per session to avoid concurrent tmp races. */
  const writeChain = new Map<string, Promise<void>>();

  const ensureDir = async () => {
    await mkdir(dir, { recursive: true });
  };

  const pathFor = (sessionKey: string) => join(dir, fileNameFor(sessionKey));

  const withSessionLock = async (
    sessionKey: string,
    fn: () => Promise<void>,
  ): Promise<void> => {
    const prev = writeChain.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(
      () => gate,
      () => gate,
    );
    writeChain.set(sessionKey, tail);
    await prev.catch(() => {});
    try {
      await fn();
    } finally {
      release();
      if (writeChain.get(sessionKey) === tail) writeChain.delete(sessionKey);
    }
  };

  const quarantineCorrupt = async (file: string, raw: string): Promise<void> => {
    const bad = `${file}.corrupt.${Date.now()}`;
    try {
      await writeFile(bad, raw, "utf8");
    } catch {
      /* ignore */
    }
    try {
      await unlink(file);
    } catch {
      /* ignore */
    }
  };

  return {
    async load(sessionKey) {
      await ensureDir();
      const file = pathFor(sessionKey);
      try {
        const raw = await readFile(file, "utf8");
        const record = parseSessionRecordJson(raw);
        if (record) return record;
        // Corrupt / truncated — quarantine so ensure can session/new cleanly.
        await quarantineCorrupt(file, raw);
        return undefined;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    },

    async save(record) {
      await ensureDir();
      await withSessionLock(record.sessionKey, async () => {
        const file = pathFor(record.sessionKey);
        const payload = `${JSON.stringify(record, null, 2)}\n`;
        await atomicWriteFile(file, payload);
      });
    },

    async delete(sessionKey) {
      await withSessionLock(sessionKey, async () => {
        try {
          await unlink(pathFor(sessionKey));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      });
    },

    async list() {
      await ensureDir();
      const names = await readdir(dir);
      const out: HostSessionRecord[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        if (name.includes(".corrupt.")) continue;
        try {
          const raw = await readFile(join(dir, name), "utf8");
          const parsed = parseSessionRecordJson(raw);
          if (parsed) out.push(parsed);
        } catch {
          /* skip unreadable */
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
