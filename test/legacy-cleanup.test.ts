import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LEGACY_OUTBOUND_QUEUE_DIRS,
  cleanupLegacyOutboundQueues,
} from "../src/core/legacy-cleanup";

describe("cleanupLegacyOutboundQueues", () => {
  test("removes telegram-queue and speak-queue when present", async () => {
    const state = await mkdtemp(join(tmpdir(), "tacp-legacy-q-"));
    try {
      for (const name of LEGACY_OUTBOUND_QUEUE_DIRS) {
        const dir = join(state, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "stale.req.json"), "{}");
      }
      // Unrelated dir must stay
      await mkdir(join(state, "sessions"), { recursive: true });
      await writeFile(join(state, "sessions", "keep.json"), "{}");

      const result = await cleanupLegacyOutboundQueues(state);
      expect(result.errors).toEqual([]);
      expect(result.removed).toHaveLength(2);
      expect(
        result.removed.every((p) =>
          LEGACY_OUTBOUND_QUEUE_DIRS.some((n) => p.endsWith(n)),
        ),
      ).toBe(true);

      const left = await readdir(state);
      expect(left).toContain("sessions");
      expect(left).not.toContain("telegram-queue");
      expect(left).not.toContain("speak-queue");
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });

  test("is a no-op when queues already gone", async () => {
    const state = await mkdtemp(join(tmpdir(), "tacp-legacy-empty-"));
    try {
      const result = await cleanupLegacyOutboundQueues(state);
      expect(result.removed).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.skipped).toHaveLength(LEGACY_OUTBOUND_QUEUE_DIRS.length);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });
});
