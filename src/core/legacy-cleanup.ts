/**
 * One-time cleanup of pre-worker-API disk queues.
 * Outbound Telegram/speak now go through the worker Unix API; leftover
 * `telegram-queue` / `speak-queue` dirs under the state dir would never drain.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";

/** Historical queue directory names under TACP_STATE_DIR. */
export const LEGACY_OUTBOUND_QUEUE_DIRS = [
  "telegram-queue",
  "speak-queue",
] as const;

export type LegacyQueueCleanupResult = {
  removed: string[];
  skipped: string[];
  errors: string[];
};

/**
 * Remove legacy outbound queue directories if present.
 * Safe to call every boot; no-ops when dirs are already gone.
 */
export async function cleanupLegacyOutboundQueues(
  stateDir: string,
  options?: { log?: Logger },
): Promise<LegacyQueueCleanupResult> {
  const log = options?.log ?? silentLogger();
  const result: LegacyQueueCleanupResult = {
    removed: [],
    skipped: [],
    errors: [],
  };

  for (const name of LEGACY_OUTBOUND_QUEUE_DIRS) {
    const path = join(stateDir, name);
    try {
      const st = await stat(path);
      if (!st.isDirectory()) {
        result.skipped.push(path);
        log.warn("legacy queue path exists but is not a directory; leaving", {
          path,
        });
        continue;
      }
      let fileHint = "";
      try {
        const entries = await readdir(path);
        if (entries.length > 0) {
          fileHint = ` (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`;
        }
      } catch {
        /* ignore listing errors; still try remove */
      }
      await rm(path, { recursive: true, force: true });
      result.removed.push(path);
      log.info("removed legacy outbound queue dir", { path, note: fileHint });
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
      if (code === "ENOENT") {
        result.skipped.push(path);
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${path}: ${msg}`);
      log.warn("failed to remove legacy queue dir", { path, error: msg });
    }
  }

  return result;
}
