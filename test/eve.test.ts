/**
 * EVE — meta extract, sandbox, schema, service with mock agent.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractEveMeta,
  extractEveBody,
  resolveEveScript,
  writeEveScript,
  listEveScripts,
} from "../src/eve/script-load";
import { validateJsonSchema, parseAgentStructuredResult } from "../src/eve/schema";
import { runEveScript } from "../src/eve/sandbox";
import { createEveService } from "../src/eve/runner";
import {
  inspectEveOutcome,
  matchEveAskAnswer,
  formatEveCompletionNotify,
  DEFAULT_BLOCKED_ASK_OPTIONS,
} from "../src/eve/outcome";
import { formatEveDigest, formatEveProgressLine } from "../src/eve/digest";

describe("EVE meta + body", () => {
  test("extracts nested phases meta", () => {
    const src = `
export const meta = {
  name: "my-drain",
  description: "Work issues",
  phases: [
    { title: "Discover" },
    { title: "Implement" },
  ],
};
phase("Discover");
`;
    const meta = extractEveMeta(src);
    expect(meta.name).toBe("my-drain");
    expect(meta.phases?.map((p) => p.title)).toEqual([
      "Discover",
      "Implement",
    ]);
  });

  test("extractEveBody strips meta and keeps pipeline body", () => {
    const source = `
export const meta = {
  name: "tiny-audit",
  description: "example",
  phases: [{ title: "Go" }],
};
phase("Go");
const r = await pipeline(items, (x) => agent(String(x)));
return r.filter(Boolean);
`;
    const body = extractEveBody(source);
    expect(body).toContain("pipeline");
    expect(body).not.toContain("export const meta");
  });

  test("resolveEveScript fails clearly when name missing (no bundled)", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "eve-miss-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "eve-repo-miss-"));
    try {
      await expect(
        resolveEveScript({ name: "linear-drain", repoRoot, stateDir }),
      ).rejects.toThrow(/eve_write|not found/i);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("EVE schema", () => {
  test("validates object schema", () => {
    const schema = {
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["done", "blocked"] },
        summary: { type: "string" },
      },
    };
    expect(validateJsonSchema(schema, { status: "done" }).ok).toBe(true);
    expect(validateJsonSchema(schema, { status: "nope" }).ok).toBe(false);
    expect(validateJsonSchema(schema, {}).ok).toBe(false);
  });

  test("parses fenced json from agent text", () => {
    const t = `Here you go:\n\`\`\`json\n{"status":"done","summary":"ok"}\n\`\`\``;
    expect(parseAgentStructuredResult(t)).toEqual({
      status: "done",
      summary: "ok",
    });
  });
});

describe("EVE sandbox", () => {
  test("runs parallel + agent injects", async () => {
    const source = `
export const meta = { name: "t", description: "test" };
const a = await parallel([
  () => agent("one", { label: "a" }),
  () => agent("two", { label: "b" }),
]);
return a.filter(Boolean);
`;
    const calls: string[] = [];
    const result = await runEveScript(source, {
      agent: async (prompt) => {
        calls.push(prompt);
        return { ok: true, prompt };
      },
      parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
      pipeline: async (items, ...stages) => {
        const out = [];
        for (let i = 0; i < items.length; i++) {
          let v: unknown = items[i];
          for (const s of stages) v = await s(v, items[i], i);
          out.push(v);
        }
        return out;
      },
      phase: () => {},
      log: () => {},
      args: undefined,
      budget: {
        agentsMax: 10,
        agentsUsed: () => 0,
        remainingAgents: () => 10,
        ok: () => true,
      },
      host: {},
    });
    expect(calls.length).toBe(2);
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(2);
  });
});

describe("EVE service", () => {
  test("write, list, run with mock agent completes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "eve-test-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "eve-repo-"));
    try {
      const svc = createEveService({
        stateDir,
        config: {
          enabled: true,
          requireApproval: false,
          maxAgentsPerRun: 20,
          maxConcurrent: 2,
          schemaRetries: 0,
        },
      });

      await writeEveScript({
        repoRoot,
        stateDir,
        name: "tiny",
        source: `
export const meta = {
  name: "tiny",
  description: "one agent",
  phases: [{ title: "Go" }],
};
phase("Go");
const r = await agent("hello", {
  label: "hi",
  schema: {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
  },
});
return r;
`,
      });

      const scripts = await listEveScripts({ repoRoot, stateDir });
      expect(scripts.some((s) => s.name === "tiny")).toBe(true);
      expect(scripts.every((s) => s.origin !== "bundled")).toBe(true);

      const resolved = await resolveEveScript({
        name: "tiny",
        repoRoot,
        stateDir,
      });
      expect(resolved.origin).toBe("project");

      const run = await svc.run(
        {
          sessionKey: "demo/topic",
          repoKey: "demo",
          repoRoot,
          name: "tiny",
          skipApproval: true,
        },
        {
          runAgent: async () => ({
            summary: '```json\n{"summary":"done"}\n```',
            status: "idle",
            childSessionKey: "demo/topic--hi",
          }),
        },
      );

      expect(run.status).toBe("completed");
      expect(run.budget.agentsUsed).toBeGreaterThanOrEqual(1);
      expect(run.finalResult).toEqual({ summary: "done" });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("blocked return parks as waiting_user and does not plant-complete", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "eve-block-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "eve-repo-block-"));
    try {
      const notes: string[] = [];
      const svc = createEveService({
        stateDir,
        config: {
          enabled: true,
          requireApproval: false,
          maxAgentsPerRun: 5,
          maxConcurrent: 1,
          schemaRetries: 0,
        },
      });

      await writeEveScript({
        repoRoot,
        stateDir,
        name: "wave1",
        source: `
export const meta = {
  name: "wave1",
  description: "stack",
};
return {
  blocked: 1,
  stopOnBlocked: true,
  results: [{
    status: "blocked",
    identifier: "PAS-45",
    summary: "review not clean after 3 rounds",
  }],
};
`,
      });

      const exec = svc.run(
        {
          sessionKey: "demo/topic",
          repoKey: "demo",
          repoRoot,
          name: "wave1",
          skipApproval: true,
        },
        {
          runAgent: async () => ({ summary: "{}", status: "idle" }),
          notify: async (_session, text) => {
            notes.push(text);
          },
        },
      );

      let runId: string | undefined;
      for (let i = 0; i < 80; i++) {
        const runs = await svc.listRuns("demo/topic");
        const waiting = runs.find((r) => r.status === "waiting_user");
        if (waiting) {
          runId = waiting.runId;
          break;
        }
        await Bun.sleep(25);
      }
      expect(runId).toBeTruthy();
      expect(notes.some((n) => n.includes("🌱 EVE complete"))).toBe(false);
      expect(notes.some((n) => /EVE stuck|PAS-45/i.test(n))).toBe(true);

      const ans = await svc.answer(runId!, "stop");
      expect(ans.ok).toBe(true);
      if (ans.ok) expect(ans.answer.id).toBe("stop");

      const finished = await exec;
      expect(finished.status).toBe("completed");
      expect(finished.finalResult).toMatchObject({
        blocked: 1,
        operatorDecision: { id: "stop" },
      });
      expect(notes.some((n) => n.includes("🌱 EVE complete"))).toBe(false);
      expect(notes.some((n) => /finished blocked|you chose/i.test(n))).toBe(
        true,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("host.ask parks mid-script and returns the operator choice", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "eve-ask-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "eve-repo-ask-"));
    try {
      const svc = createEveService({
        stateDir,
        config: {
          enabled: true,
          requireApproval: false,
          maxAgentsPerRun: 5,
          maxConcurrent: 1,
          schemaRetries: 0,
        },
      });

      await writeEveScript({
        repoRoot,
        stateDir,
        name: "ask-me",
        source: `
export const meta = { name: "ask-me", description: "ask" };
const d = await host.ask({
  question: "Continue the stack?",
  options: [
    { id: "yes", label: "Yes, continue" },
    { id: "no", label: "No, stop" },
  ],
});
return { asked: true, decision: d };
`,
      });

      const exec = svc.run(
        {
          sessionKey: "demo/topic",
          repoKey: "demo",
          repoRoot,
          name: "ask-me",
          skipApproval: true,
        },
        {
          runAgent: async () => ({ summary: "{}", status: "idle" }),
        },
      );

      let runId: string | undefined;
      for (let i = 0; i < 80; i++) {
        const runs = await svc.listRuns("demo/topic");
        const waiting = runs.find((r) => r.status === "waiting_user");
        if (waiting) {
          runId = waiting.runId;
          break;
        }
        await Bun.sleep(25);
      }
      expect(runId).toBeTruthy();

      const ans = await svc.answer(runId!, "yes");
      expect(ans.ok).toBe(true);

      const finished = await exec;
      expect(finished.status).toBe("completed");
      expect(finished.finalResult).toMatchObject({
        asked: true,
        decision: { id: "yes", label: "Yes, continue" },
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("EVE outcome", () => {
  test("classifies blocked results and never calls that clean", () => {
    const out = inspectEveOutcome(
      {
        blocked: 1,
        stopOnBlocked: true,
        results: [
          {
            status: "blocked",
            identifier: "PAS-45",
            summary: "review not clean",
          },
          { status: "done", identifier: "PAS-97" },
        ],
      },
      {},
    );
    expect(out.kind).toBe("blocked");
    expect(out.blocked).toBeGreaterThanOrEqual(1);
    expect(out.items.some((i) => i.label === "PAS-45")).toBe(true);
  });

  test("clean result stays a plant", () => {
    const notify = formatEveCompletionNotify({
      name: "tiny",
      agentsUsed: 2,
      outcome: inspectEveOutcome({ summary: "ok" }, {}),
    });
    expect(notify).toContain("🌱 EVE complete");
    expect(inspectEveOutcome({ done: 2, blocked: 0 }, {}).kind).toBe("clean");
  });

  test("digest collapses many leaf lines into counts", () => {
    const text = formatEveDigest("linear-drain", [
      { kind: "phase", title: "Implement" },
      { kind: "log", message: "Ready issues: 12" },
      { kind: "leaf", label: "pas-1", ok: true },
      { kind: "leaf", label: "pas-2", ok: true },
      { kind: "leaf", label: "pas-3", ok: true },
      { kind: "leaf", label: "pas-4", ok: true },
      { kind: "leaf", label: "pas-5", ok: true },
      { kind: "leaf", label: "pas-6", ok: false },
    ]);
    expect(text).toContain("🛰 EVE · linear-drain · 5 done · 1 failed");
    expect(text).toContain("🚫 pas-6");
    expect(text).not.toContain("✅ pas-1");
    expect(text).toContain("Ready issues: 12");
    expect(formatEveProgressLine({ kind: "leaf", label: "hi", ok: true })).toBe(
      "✅ EVE · hi done",
    );
  });

  test("matches /eve answer by number, id, or label prefix", () => {
    const opts = DEFAULT_BLOCKED_ASK_OPTIONS;
    expect(matchEveAskAnswer(opts, "1")?.id).toBe("retry");
    expect(matchEveAskAnswer(opts, "stop")?.id).toBe("stop");
    expect(matchEveAskAnswer(opts, "continue")?.id).toBe("continue");
    expect(matchEveAskAnswer(opts, "Keep fixing")?.id).toBe("retry");
    expect(matchEveAskAnswer(opts, "nope")).toBeNull();
  });
});

describe("EVE quiet progress", () => {
  test("stays silent until complete even with log + leaves", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "eve-quiet-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "eve-repo-quiet-"));
    try {
      const notes: string[] = [];
      const svc = createEveService({
        stateDir,
        config: {
          enabled: true,
          requireApproval: false,
          maxAgentsPerRun: 5,
          maxConcurrent: 1,
          schemaRetries: 0,
          digestIntervalSec: 3600,
        },
      });

      await writeEveScript({
        repoRoot,
        stateDir,
        name: "quiet",
        source: `
export const meta = { name: "quiet", description: "quiet" };
log("starting work");
const a = await agent("one", { label: "alpha" });
const b = await agent("two", { label: "beta" });
return { a, b };
`,
      });

      const run = await svc.run(
        {
          sessionKey: "demo/topic",
          repoKey: "demo",
          repoRoot,
          name: "quiet",
          skipApproval: true,
        },
        {
          runAgent: async () => ({
            summary: '{"status":"done"}',
            status: "idle",
          }),
          notify: async (_session, text) => {
            notes.push(text);
          },
        },
      );

      expect(run.status).toBe("completed");
      expect(notes).toEqual([
        expect.stringContaining("🌱 EVE complete"),
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("clean leaves-only run is just the plant", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "eve-plant-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "eve-repo-plant-"));
    try {
      const notes: string[] = [];
      const svc = createEveService({
        stateDir,
        config: {
          enabled: true,
          requireApproval: false,
          maxAgentsPerRun: 5,
          maxConcurrent: 1,
          schemaRetries: 0,
          digestIntervalSec: 3600,
        },
      });

      await writeEveScript({
        repoRoot,
        stateDir,
        name: "plant",
        source: `
export const meta = { name: "plant", description: "plant" };
await agent("one", { label: "alpha" });
return { ok: true };
`,
      });

      await svc.run(
        {
          sessionKey: "demo/topic",
          repoKey: "demo",
          repoRoot,
          name: "plant",
          skipApproval: true,
        },
        {
          runAgent: async () => ({
            summary: '{"status":"done"}',
            status: "idle",
          }),
          notify: async (_session, text) => {
            notes.push(text);
          },
        },
      );

      expect(notes).toEqual([
        expect.stringContaining("🌱 EVE complete"),
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("digest_interval_sec 0 keeps per-line notifies", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "eve-loud-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "eve-repo-loud-"));
    try {
      const notes: string[] = [];
      const svc = createEveService({
        stateDir,
        config: {
          enabled: true,
          requireApproval: false,
          maxAgentsPerRun: 5,
          maxConcurrent: 1,
          schemaRetries: 0,
          digestIntervalSec: 0,
        },
      });

      await writeEveScript({
        repoRoot,
        stateDir,
        name: "loud",
        source: `
export const meta = { name: "loud", description: "loud" };
log("hello");
await agent("one", { label: "alpha" });
return { ok: true };
`,
      });

      await svc.run(
        {
          sessionKey: "demo/topic",
          repoKey: "demo",
          repoRoot,
          name: "loud",
          skipApproval: true,
        },
        {
          runAgent: async () => ({
            summary: '{"status":"done"}',
            status: "idle",
          }),
          notify: async (_session, text) => {
            notes.push(text);
          },
        },
      );

      expect(notes).toContain("🛰 EVE · hello");
      expect(notes).toContain("✅ EVE · alpha done");
      expect(notes.some((n) => n.includes("🌱 EVE complete"))).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
