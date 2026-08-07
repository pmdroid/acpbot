/**
 * EVE host protocol: write/list/status without real agents.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startAcpHostServer } from "../src/acp-host/server";
import { createAcpHostClient } from "../src/acp-host/client";

describe("EVE host runner", () => {
  test("eve_write + eve_list + pending approval on host", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "eve-host-t-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "eve-repo-t-"));
    const sockPath = join(stateDir, "acp-host.sock");
    const host = await startAcpHostServer({
      stateDir,
      sockPath,
      enableScheduler: false,
      repos: {},
      config: {
        operatorUserId: 1,
        defaultAgent: "grok-build",
        eve: {
          enabled: true,
          requireApproval: true,
          maxAgentsPerRun: 5,
        },
      },
    });
    try {
      const client = createAcpHostClient({ sockPath });

      const source = `
export const meta = {
  name: "tiny-host",
  description: "unit test directive",
  phases: [{ title: "Go" }],
};
return { ok: true };
`;
      const w = await client.eveWrite({
        repoRoot,
        name: "tiny-host",
        source,
      });
      expect(w.path).toContain("tiny-host.js");

      const list = await client.eveList({
        sessionKey: "demo/topic",
        repoRoot,
      });
      const scripts = (list.scripts ?? []) as { name: string }[];
      expect(scripts.some((s) => s.name === "tiny-host")).toBe(true);

      const run = await client.eveRun({
        sessionKey: "demo/topic",
        repoKey: "demo",
        repoRoot,
        name: "tiny-host",
        skipApproval: false,
      });
      expect(run.runId).toBeTruthy();
      expect(run.message ?? "").toMatch(/pending approval/i);

      const st = await client.eveStatus(run.runId!);
      expect((st.run as { status?: string })?.status).toBe("pending_approval");

      await client.eveKill(run.runId!);
      const killed = await client.eveStatus(run.runId!);
      expect((killed.run as { status?: string })?.status).toBe("killed");

      await client.dispose();
    } finally {
      await host.close().catch(() => {});
      await rm(stateDir, { recursive: true, force: true }).catch(() => {});
      await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);
});
