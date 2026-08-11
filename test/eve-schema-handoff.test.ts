/**
 * EVE leaf handoff: structured parse + soft recovery after empty/completed.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isEveLeafSuccessStatus,
  parseAgentStructuredResult,
  recoverEveStructuredResult,
  softEveAgentResult,
  validateJsonSchema,
} from "../src/eve/schema";
import { createEveService } from "../src/eve/runner";
import { writeEveScript } from "../src/eve/script-load";

const prSchema = {
  type: "object",
  required: ["status", "summary", "issueId"],
  properties: {
    status: { type: "string", enum: ["done", "blocked", "partial"] },
    summary: { type: "string" },
    issueId: { type: "string" },
  },
};

describe("EVE handoff helpers", () => {
  test("empty summary parses to null", () => {
    expect(parseAgentStructuredResult("")).toBeNull();
    expect(parseAgentStructuredResult("   ")).toBeNull();
  });

  test("completed is a success status", () => {
    expect(isEveLeafSuccessStatus("completed")).toBe(true);
    expect(isEveLeafSuccessStatus("idle")).toBe(true);
    expect(isEveLeafSuccessStatus("failed")).toBe(false);
  });

  test("soft result fills issueId from pas-label", () => {
    const soft = softEveAgentResult({
      label: "pas-134",
      summary: "",
      schemaError: "$: expected object",
    });
    expect(soft.status).toBe("partial");
    expect(soft.issueId).toBe("PAS-134");
    expect(String(soft.summary)).toContain("completed");
    expect(validateJsonSchema(prSchema, soft).ok).toBe(true);
  });

  test("recover turns empty completed into soft partial", () => {
    const r = recoverEveStructuredResult({
      summary: "",
      status: "completed",
      label: "pas-135",
      schema: prSchema,
      parsed: null,
      schemaError: "$: expected object",
    });
    expect(r.value).not.toBeNull();
    expect(r.soft).toBe(true);
    expect((r.value as { issueId: string }).issueId).toBe("PAS-135");
    expect((r.value as { status: string }).status).toBe("partial");
  });

  test("recover merges free-text parse with soft issueId", () => {
    const parsed = parseAgentStructuredResult("shipped ranker and tests");
    const r = recoverEveStructuredResult({
      summary: "shipped ranker and tests",
      status: "completed",
      label: "pas-134",
      schema: prSchema,
      parsed,
      schemaError: '$.issueId: missing required "issueId"',
    });
    expect(r.value).not.toBeNull();
    const v = r.value as { status: string; summary: string; issueId: string };
    expect(v.issueId).toBe("PAS-134");
    expect(v.summary).toContain("shipped");
  });

  test("failed status does not soft-recover", () => {
    const r = recoverEveStructuredResult({
      summary: "",
      status: "failed",
      label: "pas-134",
      schema: prSchema,
      parsed: null,
    });
    expect(r.value).toBeNull();
  });
});

describe("EVE service soft handoff", () => {
  test("completed empty summary with schema soft-oks instead of null", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "eve-handoff-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "eve-handoff-repo-"));
    try {
      const svc = createEveService({
        stateDir,
        config: {
          enabled: true,
          requireApproval: false,
          maxAgentsPerRun: 10,
          maxConcurrent: 2,
          schemaRetries: 0,
        },
      });

      await writeEveScript({
        repoRoot,
        stateDir,
        name: "handoff-soft",
        source: `
export const meta = {
  name: "handoff-soft",
  description: "soft",
  phases: [{ title: "Go" }],
};
phase("Go");
const r = await agent("do work", {
  label: "pas-134",
  schema: {
    type: "object",
    required: ["status", "summary", "issueId"],
    properties: {
      status: { type: "string", enum: ["done", "blocked", "partial"] },
      summary: { type: "string" },
      issueId: { type: "string" },
    },
  },
});
return r;
`,
      });

      const run = await svc.run(
        {
          sessionKey: "demo/topic",
          repoKey: "demo",
          repoRoot,
          name: "handoff-soft",
          skipApproval: true,
        },
        {
          // Host bug case: status completed, empty assistant text.
          runAgent: async () => ({
            summary: "",
            status: "completed",
            childSessionKey: "demo/topic--pas-134",
          }),
        },
      );

      expect(run.status).toBe("completed");
      expect(run.finalResult).toMatchObject({
        status: "partial",
        issueId: "PAS-134",
      });
      const node = Object.values(run.nodes).find((n) => n.label === "pas-134");
      expect(node?.status).toBe("done");
      expect(run.logs.some((l) => l.includes("schema soft-ok"))).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
