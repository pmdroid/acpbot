/**
 * Restricted execution of EVE directive bodies.
 * Injects agent/parallel/pipeline/phase/log/args/budget/host only — no fs/net.
 */
import { extractEveBody } from "./script-load";
import type { EveAgentOptions } from "./types";

export type EveInjectedApi = {
  agent: (prompt: string, options?: EveAgentOptions) => Promise<unknown>;
  parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
  pipeline: (
    items: unknown[],
    ...stages: Array<
      (prev: unknown, item: unknown, index: number) => Promise<unknown>
    >
  ) => Promise<unknown[]>;
  phase: (title: string) => void;
  log: (message: string) => void;
  args: unknown;
  budget: {
    agentsMax: number;
    agentsUsed: () => number;
    remainingAgents: () => number;
    deadlineAt?: number;
    ok: () => boolean;
  };
  host: Record<string, unknown>;
  /** Nested directive (optional). */
  workflow?: (name: string, args?: unknown) => Promise<unknown>;
};

export async function runEveScript(
  source: string,
  api: EveInjectedApi,
): Promise<unknown> {
  const body = extractEveBody(source);
  // AsyncFunction with only injected parameter names — no require/process.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  const fn = new AsyncFunction(
    "agent",
    "parallel",
    "pipeline",
    "phase",
    "log",
    "args",
    "budget",
    "host",
    "workflow",
    `"use strict";\n${body}`,
  );

  return fn(
    api.agent,
    api.parallel,
    api.pipeline,
    api.phase,
    api.log,
    api.args,
    api.budget,
    api.host,
    api.workflow ??
      (async () => {
        throw new Error("nested workflow() not available in this run");
      }),
  );
}
