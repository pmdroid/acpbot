/**
 * Host-side EVE orchestration.
 * Script + run state live on acp-host; leaf agents are ensure+prompt slots
 * (optional git worktrees). Worker only proxies control + Telegram notify.
 */
import {
  childBranchName,
  createAgentWorktree,
  defaultWorktreePath,
} from "../core/agent-worktree";
import { createEveService, type EveService } from "./runner";
import type { EveConfig } from "./types";
import { isEveAborted } from "./daemon-bridge";

export type HostEveLeafFns = {
  /**
   * Ensure slot at cwd, run prompt, return summary text, dispose slot process.
   * owner is the worker connection for permission routing.
   */
  runLeaf: (input: {
    slotKey: string;
    agent: string;
    cwd: string;
    prompt: string;
    timeoutSec: number;
    owner: { destroyed: boolean; write: (data: string) => void } | null;
  }) => Promise<{ summary: string; status: string }>;
};

export type HostEveContext = {
  stateDir: string;
  eveConfig?: EveConfig;
  defaultAgent: string;
  notify: (sessionKey: string, text: string) => void;
  leaf: HostEveLeafFns;
};

export function createHostEveService(ctx: HostEveContext): EveService {
  return createEveService({
    stateDir: ctx.stateDir,
    config: ctx.eveConfig,
  });
}

/**
 * Build runtime deps that create a worktree + host leaf slot per agent().
 */
export function bindHostEveRuntimeDeps(input: {
  service: EveService;
  ctx: HostEveContext;
  parentSessionKey: string;
  repoRoot: string;
  repoKey: string;
  /** Worker socket that started the run (permissions / ask). */
  owner: { destroyed: boolean; write: (data: string) => void } | null;
}): Parameters<EveService["approveAndStart"]>[1] {
  const { service, ctx, parentSessionKey, repoRoot, repoKey, owner } = input;

  return {
    notify: async (sessionKey, text) => {
      ctx.notify(sessionKey, text);
    },
    shouldAbort: async (runId) => isEveAborted(runId),
    hostHelpers: {
      async linearApplyResults(results: unknown) {
        return { applied: Array.isArray(results) ? results.length : 0 };
      },
    },
    runNested: async (name, args, parent) => {
      const nested = await service.run(
        {
          sessionKey: parent.sessionKey,
          repoKey: parent.repoKey,
          repoRoot: parent.repoRoot,
          name,
          args,
          skipApproval: true,
          agentsMax: Math.max(
            1,
            parent.budget.agentsMax - parent.budget.agentsUsed,
          ),
        },
        bindHostEveRuntimeDeps({
          service,
          ctx,
          parentSessionKey: parent.sessionKey,
          repoRoot: parent.repoRoot,
          repoKey: parent.repoKey,
          owner,
        }),
      );
      return nested.finalResult ?? { status: nested.status, runId: nested.runId };
    },
    runAgent: async (leaf) => {
      const agent = leaf.agent.trim() || ctx.defaultAgent || "grok-build";
      let slug = leaf.slug
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
      if (!slug) slug = `n${Date.now().toString(36).slice(-6)}`;

      const slotKey = `${parentSessionKey}--eve-${slug}`;
      const branch = childBranchName(parentSessionKey, `eve-${slug}`, "acpbot/");
      const worktreePath = defaultWorktreePath(ctx.stateDir, repoKey, slotKey);

      let cwd = repoRoot;
      try {
        const wt = await createAgentWorktree({
          repoRoot,
          worktreePath,
          branch,
        });
        cwd = wt.worktreePath;
      } catch (err) {
        // Not a git repo or worktree fail — parent cwd (read-only audits)
        ctx.notify(
          parentSessionKey,
          `🛰 EVE · worktree skipped for ${slug}: ${
            err instanceof Error ? err.message : String(err)
          }`.slice(0, 200),
        );
        cwd = repoRoot;
      }

      const out = await ctx.leaf.runLeaf({
        slotKey,
        agent,
        cwd,
        prompt: leaf.prompt,
        timeoutSec: leaf.timeoutSec,
        owner,
      });
      return {
        summary: out.summary,
        childSessionKey: slotKey,
        status: out.status,
      };
    },
  };
}

export { markEveAbort } from "./daemon-bridge";
