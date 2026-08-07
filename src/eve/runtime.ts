/**
 * EVE runtime — orchestrates directive scripts with zero-token control flow.
 * Leaf agent() calls go through injected spawn/wait deps (worker multi-agent).
 */
import { createHash } from "node:crypto";
import {
  appendEveLog,
  loadEveRun,
  saveEveRun,
} from "./store";
import { parseAgentStructuredResult, validateJsonSchema } from "./schema";
import { runEveScript } from "./sandbox";
import type {
  EveAgentOptions,
  EveConfig,
  EveNodeState,
  EveRun,
} from "./types";
import { DEFAULT_EVE_CONFIG } from "./types";

export type EveRuntimeDeps = {
  stateDir: string;
  config?: EveConfig;
  now?: () => number;
  /**
   * Spawn a headless child, run prompt, wait for result summary.
   * Must honor worktrees when isolation !== 'none'.
   */
  runAgent: (input: {
    runId: string;
    nodeKey: string;
    slug: string;
    prompt: string;
    agent: string;
    role?: string;
    timeoutSec: number;
  }) => Promise<{ summary: string; childSessionKey?: string; status: string }>;
  /** Notify operator (Telegram). */
  notify?: (sessionKey: string, text: string) => Promise<void>;
  /** Optional host helpers exposed as `host` in scripts. */
  hostHelpers?: Record<string, (...args: unknown[]) => Promise<unknown> | unknown>;
  /** Nested workflow runner (phase 6). */
  runNested?: (name: string, args: unknown, parent: EveRun) => Promise<unknown>;
  /** Check if run was paused/killed externally. */
  shouldAbort?: (runId: string) => boolean | Promise<boolean>;
};

function cacheKey(
  prompt: string,
  options: EveAgentOptions | undefined,
  seq: number,
): string {
  const h = createHash("sha256");
  h.update(String(seq));
  h.update("\0");
  h.update(prompt);
  h.update("\0");
  h.update(JSON.stringify(options ?? {}));
  return h.digest("hex").slice(0, 24);
}

function slugFromLabel(label: string | undefined, seq: number): string {
  const base = (label ?? `n${seq}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return (base || `n${seq}`).slice(0, 28);
}

export async function executeEveRun(
  deps: EveRuntimeDeps,
  runId: string,
): Promise<EveRun> {
  const cfg = { ...DEFAULT_EVE_CONFIG, ...deps.config };
  let run = await loadEveRun(deps.stateDir, runId);
  if (!run) throw new Error(`EVE run not found: ${runId}`);
  if (run.status === "killed") return run;
  if (run.status === "completed" || run.status === "failed") return run;

  run = {
    ...run,
    status: "running",
    approvedAt: run.approvedAt ?? Date.now(),
  };
  run = appendEveLog(run, "EVE directive started");
  await saveEveRun(deps.stateDir, run);

  let agentsUsed = run.budget.agentsUsed;
  let agentSeq = Object.keys(run.resultCache).length;
  let activePhase = run.phases.find((p) => p.status === "active")?.title;
  let concurrent = 0;
  const maxConcurrent = Math.max(1, cfg.maxConcurrent);
  const waitQueue: Array<() => void> = [];

  const acquireSlot = async (): Promise<void> => {
    if (concurrent < maxConcurrent) {
      concurrent++;
      return;
    }
    await new Promise<void>((resolve) => waitQueue.push(resolve));
    concurrent++;
  };
  const releaseSlot = (): void => {
    concurrent = Math.max(0, concurrent - 1);
    const next = waitQueue.shift();
    if (next) next();
  };

  const persist = async (next: EveRun): Promise<EveRun> => {
    await saveEveRun(deps.stateDir, next);
    return next;
  };

  const checkAbort = async (): Promise<void> => {
    if (await deps.shouldAbort?.(runId)) {
      throw new Error("EVE run aborted (paused or killed)");
    }
    const fresh = await loadEveRun(deps.stateDir, runId);
    if (fresh?.status === "paused") {
      throw new Error("EVE run paused");
    }
    if (fresh?.status === "killed") {
      throw new Error("EVE run killed");
    }
  };

  const budgetApi = {
    agentsMax: run.budget.agentsMax,
    agentsUsed: () => agentsUsed,
    remainingAgents: () => Math.max(0, run.budget.agentsMax - agentsUsed),
    deadlineAt: run.budget.deadlineAt,
    ok: () => {
      if (agentsUsed >= run.budget.agentsMax) return false;
      if (run.budget.deadlineAt && Date.now() >= run.budget.deadlineAt) {
        return false;
      }
      return true;
    },
  };

  const setPhase = async (title: string): Promise<void> => {
    activePhase = title;
    const phases = run.phases.map((p) => {
      if (p.title === title) return { ...p, status: "active" as const };
      if (p.status === "active") return { ...p, status: "done" as const };
      return p;
    });
    // If phase not in meta, append
    if (!phases.some((p) => p.title === title)) {
      phases.push({ title, status: "active", agentCount: 0 });
    }
    run = await persist({ ...run, phases });
    run = await persist(appendEveLog(run, `phase: ${title}`));
  };

  const agentFn = async (
    prompt: string,
    options?: EveAgentOptions,
  ): Promise<unknown> => {
    await checkAbort();
    if (!budgetApi.ok()) {
      throw new Error(
        `EVE budget exhausted (agents ${agentsUsed}/${run.budget.agentsMax})`,
      );
    }

    const seq = ++agentSeq;
    const key = cacheKey(prompt, options, seq);
    // Resume: if we already have this sequential key from a prior partial run,
    // prefer resultCache by label+phase first for friendlier resume.
    const labelKey = `${options?.phase ?? activePhase ?? ""}::${options?.label ?? seq}`;
    if (labelKey in run.resultCache && run.resultCache[labelKey] !== undefined) {
      return run.resultCache[labelKey];
    }
    if (key in run.resultCache) {
      return run.resultCache[key];
    }

    agentsUsed++;
    run = {
      ...run,
      budget: { ...run.budget, agentsUsed },
    };
    const nodeKey = labelKey || key;
    const node: EveNodeState = {
      status: "running",
      startedAt: Date.now(),
      label: options?.label,
      phase: options?.phase ?? activePhase,
    };
    run = await persist({
      ...run,
      nodes: { ...run.nodes, [nodeKey]: node },
    });

    // Bump phase agent count
    if (options?.phase || activePhase) {
      const pt = options?.phase ?? activePhase!;
      run = await persist({
        ...run,
        phases: run.phases.map((p) =>
          p.title === pt ? { ...p, agentCount: p.agentCount + 1 } : p,
        ),
      });
    }

    await acquireSlot();
    try {
      const agentId =
        options?.agent?.trim() ||
        options?.model?.trim() ||
        cfg.defaultAgent ||
        "grok-build";
      const timeoutSec = options?.timeout_sec ?? 900;
      const slug = slugFromLabel(options?.label, seq);

      const schemaRetries = Math.max(0, cfg.schemaRetries);
      let lastSummary = "";
      let lastStatus = "failed";
      let childSessionKey: string | undefined;
      let parsed: unknown = null;

      for (let attempt = 0; attempt <= schemaRetries; attempt++) {
        await checkAbort();
        const retryHint =
          attempt === 0
            ? ""
            : `\n\nYour previous reply did not match the required JSON schema. ` +
              `Reply with ONLY valid JSON matching the schema. Error: ${
                typeof parsed === "object" && parsed && "error" in (parsed as object)
                  ? String((parsed as { error?: string }).error)
                  : "validation failed"
              }`;

        const fullPrompt =
          prompt +
          (options?.schema
            ? `\n\nReturn a single JSON object matching this schema:\n${JSON.stringify(options.schema, null, 2)}\n` +
              `Wrap it in a \`\`\`json fence if needed.`
            : "") +
          retryHint;

        const out = await deps.runAgent({
          runId,
          nodeKey,
          slug: attempt === 0 ? slug : `${slug}-r${attempt}`,
          prompt: fullPrompt,
          agent: agentId,
          role: options?.role ?? "eve-worker",
          timeoutSec,
        });
        lastSummary = out.summary ?? "";
        lastStatus = out.status;
        childSessionKey = out.childSessionKey;
        parsed = parseAgentStructuredResult(lastSummary);

        if (!options?.schema) break;
        const v = validateJsonSchema(
          options.schema as Record<string, unknown>,
          parsed,
        );
        if (v.ok) break;
        parsed = { error: v.error };
        if (attempt === schemaRetries) {
          run = await persist(
            appendEveLog(
              run,
              `schema fail ${options?.label ?? nodeKey}: ${v.error}`,
            ),
          );
          parsed = null;
        }
      }

      const failed =
        parsed === null ||
        lastStatus === "failed" ||
        lastStatus === "killed";

      run = await persist({
        ...run,
        nodes: {
          ...run.nodes,
          [nodeKey]: {
            status: failed ? "failed" : "done",
            childSessionKey,
            result: parsed,
            finishedAt: Date.now(),
            label: options?.label,
            phase: options?.phase ?? activePhase,
            ...(failed ? { error: lastSummary.slice(0, 500) || lastStatus } : {}),
          },
        },
        resultCache: {
          ...run.resultCache,
          [labelKey]: failed ? null : parsed,
          [key]: failed ? null : parsed,
        },
      });

      if (deps.notify && options?.label) {
        const icon = failed ? "🚫" : "✅";
        await deps.notify(
          run.sessionKey,
          `${icon} EVE · ${options.label}${failed ? " failed" : " done"}`,
        ).catch(() => {});
      }

      return failed ? null : parsed;
    } finally {
      releaseSlot();
    }
  };

  const parallelFn = async (
    thunks: Array<() => Promise<unknown>>,
  ): Promise<unknown[]> => {
    const list = thunks ?? [];
    if (list.length > 4096) {
      throw new Error("parallel() capped at 4096 thunks");
    }
    return Promise.all(
      list.map(async (t) => {
        try {
          return await t();
        } catch (err) {
          run = await persist(
            appendEveLog(
              run,
              `parallel thunk error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          return null;
        }
      }),
    );
  };

  const pipelineFn = async (
    items: unknown[],
    ...stages: Array<
      (prev: unknown, item: unknown, index: number) => Promise<unknown>
    >
  ): Promise<unknown[]> => {
    if (!Array.isArray(items)) throw new Error("pipeline() items must be an array");
    if (items.length > 4096) throw new Error("pipeline() capped at 4096 items");
    if (stages.length === 0) return items;

    return Promise.all(
      items.map(async (item, index) => {
        let prev: unknown = item;
        try {
          for (const stage of stages) {
            prev = await stage(prev, item, index);
            if (prev === null || prev === undefined) return null;
          }
          return prev;
        } catch (err) {
          run = await persist(
            appendEveLog(
              run,
              `pipeline item ${index} error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          return null;
        }
      }),
    );
  };

  const logFn = (message: string): void => {
    void (async () => {
      run = await persist(appendEveLog(run, message));
      if (deps.notify) {
        await deps.notify(run.sessionKey, `🛰 EVE · ${message}`).catch(() => {});
      }
    })();
  };

  const host: Record<string, unknown> = {
    sessionKey: run.sessionKey,
    repoKey: run.repoKey,
    repoRoot: run.repoRoot,
    runId: run.runId,
    ...(deps.hostHelpers ?? {}),
  };

  const source = await Bun.file(run.scriptPath).text().catch(async () => {
    // frozen path might be relative
    const { readFile } = await import("node:fs/promises");
    return readFile(run.scriptPath, "utf8");
  });

  try {
    const result = await runEveScript(source, {
      agent: agentFn,
      parallel: parallelFn,
      pipeline: pipelineFn,
      phase: (title: string) => {
        void setPhase(title);
      },
      log: logFn,
      args: run.args,
      budget: budgetApi,
      host,
      workflow: deps.runNested
        ? async (name: string, args?: unknown) =>
            deps.runNested!(name, args, run)
        : undefined,
    });

    // mark remaining active phases done
    run = await persist({
      ...run,
      status: "completed",
      finalResult: result ?? null,
      budget: { ...run.budget, agentsUsed },
      phases: run.phases.map((p) =>
        p.status === "active" || p.status === "pending"
          ? { ...p, status: "done" as const }
          : p,
      ),
    });
    run = await persist(appendEveLog(run, "EVE directive completed"));
    if (deps.notify) {
      await deps.notify(
        run.sessionKey,
        `🌱 EVE complete · **${run.name}** · agents ${agentsUsed}`,
      ).catch(() => {});
    }
    return run;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const paused = /paused/i.test(message);
    const killed = /killed/i.test(message);
    run = await persist({
      ...run,
      status: killed ? "killed" : paused ? "paused" : "failed",
      error: message,
      budget: { ...run.budget, agentsUsed },
    });
    run = await persist(appendEveLog(run, `EVE stopped: ${message}`));
    if (deps.notify && !paused) {
      await deps.notify(
        run.sessionKey,
        `⚠️ EVE ${run.status} · **${run.name}** · ${message.slice(0, 200)}`,
      ).catch(() => {});
    }
    return run;
  }
}
