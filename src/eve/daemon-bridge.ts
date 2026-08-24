/**
 * Wire EVE runtime to multi-agent spawn handlers (daemon worker-api).
 */
import type { EveRuntimeDeps } from "./runtime";
import type { EveConfig, EveRun } from "./types";
import { createEveService, type EveService } from "./runner";

/** Active run abort flags (pause/kill) — process-local (host owns runs). */
const abortFlags = new Map<string, boolean>();

export function markEveAbort(runId: string, abort: boolean): void {
  if (abort) abortFlags.set(runId, true);
  else abortFlags.delete(runId);
}

export function isEveAborted(runId: string): boolean {
  return abortFlags.get(runId) === true;
}

export function createEveDaemonService(input: {
  stateDir: string;
  eveConfig?: EveConfig;
}): EveService {
  return createEveService({
    stateDir: input.stateDir,
    config: input.eveConfig,
  });
}

export type EveLeafSpawn = (input: {
  sessionKey: string;
  name: string;
  agent?: string;
  role?: string;
  prompt?: string;
  headless?: boolean;
}) => Promise<{ message?: string; record?: { childSessionKey?: string; lastResultSummary?: string; status?: string } }>;

export type EveLeafWait = (input: {
  sessionKey: string;
  to?: string;
  childSessionKey?: string;
  timeout_sec?: number;
  poll_sec?: number;
}) => Promise<{
  message?: string;
  status?: string;
  summary?: string;
  sessionKey?: string;
}>;

export type EveLeafKill = (input: {
  sessionKey: string;
  childSessionKey?: string;
  dispose?: boolean;
}) => Promise<{ message?: string }>;

/**
 * Bind runtime deps to a parent session + leaf spawn/wait (already wired in daemon).
 */
export function bindEveRuntimeDeps(input: {
  parentSessionKey: string;
  defaultAgent: string;
  notify: (sessionKey: string, text: string) => Promise<void>;
  agentSpawn: EveLeafSpawn;
  agentWait: EveLeafWait;
  /** Soft-close child after leaf finishes so spawn caps free up. */
  agentKill?: EveLeafKill;
  service: EveService;
}): Pick<
  EveRuntimeDeps,
  "runAgent" | "notify" | "shouldAbort" | "runNested" | "hostHelpers"
> {
  const {
    parentSessionKey,
    defaultAgent,
    notify,
    agentSpawn,
    agentWait,
    agentKill,
    service,
  } = input;

  const runNested = async (
    name: string,
    args: unknown,
    parent: Pick<EveRun, "sessionKey" | "repoKey" | "repoRoot" | "budget">,
  ) => {
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
      bindEveRuntimeDeps({
        parentSessionKey: parent.sessionKey,
        defaultAgent,
        notify,
        agentSpawn,
        agentWait,
        agentKill,
        service,
      }),
    );
    return nested.finalResult ?? { status: nested.status, runId: nested.runId };
  };

  return {
    notify,
    shouldAbort: async (runId: string) => abortFlags.get(runId) === true,
    hostHelpers: {},
    runNested,
    runAgent: async (leaf) => {
      const agent = leaf.agent.trim() || defaultAgent || "grok-build";
      let slug = leaf.slug
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 28);
      if (!slug) slug = `eve-${leaf.nodeKey.slice(0, 8)}`;

      const trySpawn = async (name: string) => {
        const out = await agentSpawn({
          sessionKey: parentSessionKey,
          name,
          agent,
          role: leaf.role ?? "eve-worker",
          prompt: leaf.prompt,
          headless: true,
        });
        const childKey =
          out.record && typeof out.record.childSessionKey === "string"
            ? out.record.childSessionKey
            : `${parentSessionKey}--${name}`;
        const waited = await agentWait({
          sessionKey: parentSessionKey,
          childSessionKey: childKey,
          to: childKey,
          timeout_sec: leaf.timeoutSec,
          poll_sec: 2,
        });
        // Free spawn slots for the next leaf (hard dispose registry entry,
        // keep worktree by default via agent_kill defaults).
        if (agentKill) {
          await agentKill({
            sessionKey: parentSessionKey,
            childSessionKey: childKey,
            dispose: true,
          }).catch(() => {});
        }
        return {
          summary:
            waited.summary ||
            (out.record && typeof out.record.lastResultSummary === "string"
              ? out.record.lastResultSummary
              : "") ||
            "",
          childSessionKey: childKey,
          status: waited.status || out.record?.status || "idle",
        };
      };

      try {
        return await trySpawn(slug);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/already exists/i.test(message)) {
          try {
            return await trySpawn(
              `${slug.slice(0, 20)}-${Date.now().toString(36).slice(-4)}`,
            );
          } catch (err2) {
            return {
              summary: err2 instanceof Error ? err2.message : String(err2),
              status: "failed",
            };
          }
        }
        return { summary: message, status: "failed" };
      }
    },
  };
}
