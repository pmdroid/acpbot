/**
 * High-level EVE API: resolve script, create run, approve, execute.
 */
import {
  createEveRun,
  loadEveRun,
  saveEveRun,
  listEveRuns,
  appendEveLog,
  newRunId,
} from "./store";
import {
  freezeScriptForRun,
  listEveScripts,
  resolveEveScript,
  writeEveScript,
  extractEveMeta,
} from "./script-load";
import { answerEveAsk, executeEveRun, type EveRuntimeDeps } from "./runtime";
import type { EveAskAnswer, EveConfig, EveRun } from "./types";
import { DEFAULT_EVE_CONFIG, EVE_BRAND, EVE_TAGLINE } from "./types";
import { inspectEveOutcome } from "./outcome";

export { EVE_BRAND, EVE_TAGLINE, EVE_FULL_NAME } from "./types";
export type { EveRun, EveConfig } from "./types";
export type { EveRuntimeDeps } from "./runtime";

export type EveService = {
  config: EveConfig;
  stateDir: string;
  createRun: (input: {
    sessionKey: string;
    repoKey: string;
    repoRoot: string;
    name?: string;
    path?: string;
    source?: string;
    args?: unknown;
    skipApproval?: boolean;
    agentsMax?: number;
    deadlineAt?: number;
  }) => Promise<EveRun>;
  approveAndStart: (
    runId: string,
    deps: Pick<EveRuntimeDeps, "runAgent" | "notify" | "hostHelpers" | "runNested" | "shouldAbort">,
  ) => Promise<EveRun>;
  /** Create + start when approval not required or skipApproval. */
  run: (
    input: {
      sessionKey: string;
      repoKey: string;
      repoRoot: string;
      name?: string;
      path?: string;
      source?: string;
      args?: unknown;
      skipApproval?: boolean;
      agentsMax?: number;
    },
    deps: Pick<EveRuntimeDeps, "runAgent" | "notify" | "hostHelpers" | "runNested" | "shouldAbort">,
  ) => Promise<EveRun>;
  pause: (runId: string) => Promise<EveRun>;
  resume: (
    runId: string,
    deps: Pick<EveRuntimeDeps, "runAgent" | "notify" | "hostHelpers" | "runNested" | "shouldAbort">,
  ) => Promise<EveRun>;
  kill: (runId: string) => Promise<EveRun>;
  /** Resolve a waiting_user question (`/eve answer`). */
  answer: (
    runId: string,
    raw: string,
  ) => Promise<
    | { ok: true; answer: EveAskAnswer; waiterAlive: boolean; run: EveRun }
    | { ok: false; error: string; run?: EveRun }
  >;
  status: (runId: string) => Promise<EveRun | null>;
  listRuns: (sessionKey?: string) => Promise<EveRun[]>;
  listScripts: (repoRoot: string) => Promise<
    { name: string; description: string; origin: string; path: string }[]
  >;
  writeScript: (input: {
    repoRoot: string;
    name: string;
    source: string;
    scope?: "project" | "user";
  }) => Promise<{ path: string; meta: { name: string; description: string } }>;
  formatStatus: (run: EveRun) => string;
};

export function createEveService(input: {
  stateDir: string;
  config?: EveConfig;
}): EveService {
  const config = { ...DEFAULT_EVE_CONFIG, ...input.config };
  const stateDir = input.stateDir;

  const createRun: EveService["createRun"] = async (opts) => {
    if (!config.enabled) {
      throw new Error(
        "EVE is disabled ([eve].enabled = false). Set enabled = true in config.toml.",
      );
    }
    const resolved = await resolveEveScript({
      name: opts.name,
      path: opts.path,
      source: opts.source,
      repoRoot: opts.repoRoot,
      stateDir,
    });
    const runId = newRunId();
    const scriptPath = await freezeScriptForRun({
      stateDir,
      runId,
      source: resolved.source,
    });
    const needApproval = config.requireApproval && !opts.skipApproval;
    const run = createEveRun({
      runId,
      name: resolved.meta.name,
      sessionKey: opts.sessionKey,
      repoKey: opts.repoKey,
      repoRoot: opts.repoRoot,
      scriptPath,
      args: opts.args,
      meta: resolved.meta,
      budget: {
        agentsMax: opts.agentsMax ?? config.maxAgentsPerRun,
        agentsUsed: 0,
        ...(opts.deadlineAt ? { deadlineAt: opts.deadlineAt } : {}),
      },
      status: needApproval ? "pending_approval" : "running",
    });
    let saved = appendEveLog(
      run,
      `created from ${resolved.origin} · ${resolved.path}`,
    );
    if (!needApproval) {
      saved = { ...saved, approvedAt: Date.now() };
    }
    await saveEveRun(stateDir, saved);
    return saved;
  };

  const approveAndStart: EveService["approveAndStart"] = async (runId, deps) => {
    let run = await loadEveRun(stateDir, runId);
    if (!run) throw new Error(`EVE run not found: ${runId}`);
    if (run.status === "pending_approval") {
      run = {
        ...run,
        status: "running",
        approvedAt: Date.now(),
      };
      run = appendEveLog(run, "approved by operator");
      await saveEveRun(stateDir, run);
    }
    return executeEveRun(
      {
        stateDir,
        config,
        runAgent: deps.runAgent,
        notify: deps.notify,
        hostHelpers: deps.hostHelpers,
        runNested: deps.runNested,
        shouldAbort: deps.shouldAbort,
      },
      runId,
    );
  };

  const run: EveService["run"] = async (opts, deps) => {
    const created = await createRun({
      ...opts,
      skipApproval: opts.skipApproval ?? !config.requireApproval,
    });
    if (created.status === "pending_approval") {
      return created;
    }
    return approveAndStart(created.runId, deps);
  };

  return {
    config,
    stateDir,
    createRun,
    approveAndStart,
    run,
    async pause(runId) {
      const run = await loadEveRun(stateDir, runId);
      if (!run) throw new Error(`EVE run not found: ${runId}`);
      const next = appendEveLog(
        { ...run, status: "paused" },
        "paused by operator",
      );
      await saveEveRun(stateDir, next);
      return next;
    },
    async resume(runId, deps) {
      const run = await loadEveRun(stateDir, runId);
      if (!run) throw new Error(`EVE run not found: ${runId}`);
      if (run.status !== "paused" && run.status !== "failed") {
        // allow re-run of incomplete / continue a parked ask
      }
      const next = appendEveLog(
        { ...run, status: "running", error: undefined },
        "resumed by operator",
      );
      await saveEveRun(stateDir, next);
      return executeEveRun(
        {
          stateDir,
          config,
          runAgent: deps.runAgent,
          notify: deps.notify,
          hostHelpers: deps.hostHelpers,
          runNested: deps.runNested,
          shouldAbort: deps.shouldAbort,
        },
        runId,
      );
    },
    async answer(runId, raw) {
      return answerEveAsk(stateDir, runId, raw);
    },
    async kill(runId) {
      const run = await loadEveRun(stateDir, runId);
      if (!run) throw new Error(`EVE run not found: ${runId}`);
      const next = appendEveLog(
        { ...run, status: "killed" },
        "killed by operator",
      );
      await saveEveRun(stateDir, next);
      return next;
    },
    status: (runId) => loadEveRun(stateDir, runId),
    listRuns: (sessionKey) => listEveRuns(stateDir, { sessionKey, limit: 30 }),
    listScripts: (repoRoot) => listEveScripts({ repoRoot, stateDir }),
    async writeScript(opts) {
      return writeEveScript({
        repoRoot: opts.repoRoot,
        stateDir,
        name: opts.name,
        source: opts.source,
        scope: opts.scope,
      });
    },
    formatStatus(run) {
      const lines = [
        `🛰 **EVE** · \`${run.name}\` · \`${run.runId.slice(0, 8)}\``,
        `**${run.status}** · agents ${run.budget.agentsUsed}/${run.budget.agentsMax}`,
      ];
      if (run.status === "waiting_user" && run.pendingAsk) {
        lines.push(`❓ ${run.pendingAsk.question.split("\n")[0]}`);
        for (const [i, o] of run.pendingAsk.options.entries()) {
          lines.push(`  ${i + 1}) ${o.label}`);
        }
        lines.push(`\`/eve answer ${run.runId.slice(0, 8)} 1\``);
      }
      const outcome = inspectEveOutcome(run.finalResult, run.nodes);
      if (run.status === "completed") {
        if (outcome.kind === "clean") {
          lines.push(`🌱 ${outcome.done} done`);
        } else {
          lines.push(
            `**${outcome.kind}** · ${outcome.done} done · ${outcome.blocked} blocked · ${outcome.failed} failed`,
          );
        }
      }
      if (run.phases.length) {
        lines.push(
          run.phases
            .map((p) => `${p.title} ${p.status}`)
            .join(" · "),
        );
      }
      const nodes = Object.entries(run.nodes);
      if (nodes.length) {
        const running = nodes.filter(([, n]) => n.status === "running");
        const done = nodes.filter(([, n]) => n.status === "done").length;
        const failed = nodes.filter(([, n]) => n.status === "failed").length;
        lines.push(
          `${done} done · ${failed} failed` +
            (running.length ? ` · ${running.length} running` : ""),
        );
        for (const [, n] of running.slice(0, 5)) {
          lines.push(`⏳ ${n.label ?? "agent"}`);
        }
      }
      if (run.error) lines.push(run.error.slice(0, 240));
      return lines.join("\n");
    },
  };
}

/** Re-export helpers for tests. */
export { extractEveMeta, resolveEveScript, writeEveScript } from "./script-load";
export { executeEveRun, answerEveAsk, hasEveAskWaiter } from "./runtime";
export {
  inspectEveOutcome,
  formatEveCompletionNotify,
  formatEveStuckMessage,
} from "./outcome";
export {
  validateJsonSchema,
  parseAgentStructuredResult,
  softEveAgentResult,
  recoverEveStructuredResult,
  isEveLeafSuccessStatus,
} from "./schema";
