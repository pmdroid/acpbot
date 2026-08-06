/**
 * EVE — meta extract, sandbox, schema, service with mock agent.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
import { bundledEveDir } from "../src/eve/script-load";

describe("EVE meta + body", () => {
  test("extracts nested phases meta", () => {
    const src = `
export const meta = {
  name: "linear-drain",
  description: "Work issues",
  phases: [
    { title: "Discover" },
    { title: "Implement" },
  ],
};
phase("Discover");
`;
    const meta = extractEveMeta(src);
    expect(meta.name).toBe("linear-drain");
    expect(meta.phases?.map((p) => p.title)).toEqual([
      "Discover",
      "Implement",
    ]);
  });

  test("bundled linear-drain parses", async () => {
    const path = join(bundledEveDir(), "linear-drain.js");
    const source = await readFile(path, "utf8");
    const meta = extractEveMeta(source);
    expect(meta.name).toBe("linear-drain");
    const body = extractEveBody(source);
    expect(body).toContain("pipeline");
    expect(body).not.toContain("export const meta");
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

      // Also resolve bundled
      const bundled = await resolveEveScript({
        name: "linear-drain",
        repoRoot,
        stateDir,
      });
      expect(bundled.origin).toBe("bundled");

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
});
