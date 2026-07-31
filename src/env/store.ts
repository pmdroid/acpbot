import type { Store } from "./types";

export function memoryStore(seed?: Map<string, unknown>): Store {
  const data = seed ?? new Map<string, unknown>();
  return {
    async load<T>(key: string): Promise<T | undefined> {
      if (!data.has(key)) return undefined;
      return structuredClone(data.get(key)) as T;
    },
    async save<T>(key: string, value: T): Promise<void> {
      data.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
    async listKeys(prefix?: string): Promise<string[]> {
      const keys = [...data.keys()];
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    },
  };
}

/**
 * Serialize async work on a single chain so concurrent callers never interleave
 * read-modify-write on the same file.
 */
function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn);
    // Keep the chain alive even if a task rejects.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/**
 * JSON-file backed store. Path is configuration — callers pass it in; the
 * store never assumes a fixed layout under $HOME or similar.
 *
 * All mutations are serialized so concurrent save() of different keys cannot
 * clobber each other via whole-file RMW races.
 */
export async function createJsonFileStore(filePath: string): Promise<Store> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const exclusive = createMutex();

  // In-memory mirror kept coherent under the mutex so save A then save B
  // always composes, even if the process is mid-write.
  let cache: Record<string, unknown> | null = null;

  const loadCache = async (): Promise<Record<string, unknown>> => {
    if (cache) return cache;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      cache = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        cache = {};
      } else {
        throw err;
      }
    }
    return cache;
  };

  const persist = async (): Promise<void> => {
    if (!cache) return;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Atomic-ish: write temp then rename to avoid torn reads.
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await fs.rename(tmp, filePath);
  };

  return {
    async load<T>(key: string): Promise<T | undefined> {
      return exclusive(async () => {
        const all = await loadCache();
        if (!(key in all)) return undefined;
        return structuredClone(all[key]) as T;
      });
    },
    async save<T>(key: string, value: T): Promise<void> {
      return exclusive(async () => {
        const all = await loadCache();
        all[key] = structuredClone(value);
        await persist();
      });
    },
    async delete(key: string): Promise<void> {
      return exclusive(async () => {
        const all = await loadCache();
        delete all[key];
        await persist();
      });
    },
    async listKeys(prefix?: string): Promise<string[]> {
      return exclusive(async () => {
        const all = await loadCache();
        const keys = Object.keys(all);
        return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
      });
    },
  };
}
