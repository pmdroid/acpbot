import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildReviewBundle } from "../src/core/review-bundle";
import {
  coerceReviewReport,
  mergePanelReports,
  parseReviewReport,
  applyChallenge,
  parseChallengeReport,
  filterReportByPriority,
} from "../src/core/review-schema";
import { runReviewPanel } from "../src/core/review-panel";

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "acpbot-review-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  await writeFile(join(dir, "a.ts"), "export const x = 1;\n", "utf8");
  git(dir, ["add", "a.ts"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

describe("review-schema", () => {
  test("parse fenced report and filter priority", () => {
    const text = `\`\`\`json
{
  "findings": [
    {
      "title": "null deref",
      "body": "x can be null",
      "priority": "P0",
      "confidence": 0.9,
      "category": "bug",
      "code_location": { "file_path": "a.ts", "line": 10 }
    },
    {
      "title": "nit name",
      "body": "rename",
      "priority": "P3",
      "confidence": 0.4,
      "category": "maintainability",
      "code_location": { "file_path": "a.ts", "line": 2 }
    }
  ],
  "overall_correctness": "patch is incorrect",
  "overall_explanation": "has a bug",
  "overall_confidence": 0.8
}
\`\`\``;
    const report = parseReviewReport(text);
    expect(report.findings).toHaveLength(2);
    const p0 = filterReportByPriority(report, "P0");
    expect(p0.findings).toHaveLength(1);
    expect(p0.findings[0]!.title).toBe("null deref");
  });

  test("merge agrees on same file:line:title", () => {
    const f = {
      title: "null deref",
      body: "x",
      priority: "P0" as const,
      confidence: 0.8,
      category: "bug" as const,
      code_location: { file_path: "a.ts", line: 10 },
    };
    const merged = mergePanelReports([
      {
        reviewer: "codex",
        report: {
          findings: [f],
          overall_correctness: "patch is incorrect",
          overall_explanation: "bad",
          overall_confidence: 0.8,
        },
      },
      {
        reviewer: "claude",
        report: {
          findings: [{ ...f, confidence: 0.95, body: "x can be null" }],
          overall_correctness: "patch is incorrect",
          overall_explanation: "bad",
          overall_confidence: 0.9,
        },
      },
    ]);
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]!.agreement).toBe("agreed");
    expect(merged.findings[0]!.sources).toEqual(["codex", "claude"]);
    expect(merged.agreedCount).toBe(1);
  });

  test("challenge accept/reject", () => {
    const finder = coerceReviewReport({
      findings: [
        {
          title: "bug a",
          body: "a",
          priority: "P0",
          confidence: 0.9,
          category: "bug",
          code_location: { file_path: "a.ts", line: 1 },
        },
        {
          title: "bug b",
          body: "b",
          priority: "P0",
          confidence: 0.5,
          category: "bug",
          code_location: { file_path: "a.ts", line: 2 },
        },
      ],
      overall_correctness: "patch is incorrect",
      overall_explanation: "two",
      overall_confidence: 0.7,
    });
    const challenge = parseChallengeReport(
      JSON.stringify({
        decisions: [
          {
            title: "bug a",
            file_path: "a.ts",
            line: 1,
            outcome: "accept",
            reason: "real",
          },
          {
            title: "bug b",
            file_path: "a.ts",
            line: 2,
            outcome: "reject",
            reason: "speculative",
          },
        ],
        overall_explanation: "one real",
      }),
    );
    const { accepted, rejected } = applyChallenge(finder, challenge);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.title).toBe("bug a");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("speculative");
  });
});

describe("review-bundle", () => {
  test("local dirty freeze", async () => {
    const repo = await initRepo();
    const state = await mkdtemp(join(tmpdir(), "acpbot-state-"));
    try {
      await writeFile(join(repo, "a.ts"), "export const x = 2;\n", "utf8");
      const bundle = buildReviewBundle({
        cwd: repo,
        mode: "local",
        stateDir: state,
      });
      expect(bundle.empty).toBe(false);
      expect(bundle.diffText).toContain("export const x");
      expect(bundle.files).toContain("a.ts");
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });

  test("empty local is empty", async () => {
    const repo = await initRepo();
    const state = await mkdtemp(join(tmpdir(), "acpbot-state-"));
    try {
      const bundle = buildReviewBundle({
        cwd: repo,
        mode: "local",
        stateDir: state,
      });
      expect(bundle.empty).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });
});

describe("review-panel", () => {
  test("panel merges two stub reviewers", async () => {
    const repo = await initRepo();
    const state = await mkdtemp(join(tmpdir(), "acpbot-state-"));
    try {
      await writeFile(join(repo, "a.ts"), "export const x = 3;\n", "utf8");
      const finding = {
        title: "value change",
        body: "x changed",
        priority: "P0",
        confidence: 0.7,
        category: "regression",
        code_location: { file_path: "a.ts", line: 1 },
      };
      const result = await runReviewPanel({
        cwd: repo,
        stateDir: state,
        mode: "local",
        protocol: "panel",
        maxPriority: "P1",
        reviewers: [{ agent: "codex" }, { agent: "claude" }],
        runReviewer: async ({ label }) => ({
          text: JSON.stringify({
            findings: [finding],
            overall_correctness: "patch is incorrect",
            overall_explanation: `from ${label}`,
            overall_confidence: 0.8,
          }),
        }),
      });
      expect(result.merged.findings).toHaveLength(1);
      expect(result.merged.findings[0]!.agreement).toBe("agreed");
      expect(result.markdown).toContain("AGREED");
      expect(result.reviewers).toEqual(["codex", "claude"]);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });

  test("adversarial challenge filters findings", async () => {
    const repo = await initRepo();
    const state = await mkdtemp(join(tmpdir(), "acpbot-state-"));
    try {
      await mkdir(join(repo, "src"), { recursive: true });
      await writeFile(join(repo, "a.ts"), "export const x = 4;\n", "utf8");
      let call = 0;
      const result = await runReviewPanel({
        cwd: repo,
        stateDir: state,
        mode: "local",
        protocol: "adversarial",
        maxPriority: "P0",
        reviewers: [{ agent: "codex", label: "codex" }, { agent: "claude", label: "claude" }],
        runReviewer: async () => {
          call += 1;
          if (call === 1) {
            return {
              text: JSON.stringify({
                findings: [
                  {
                    title: "real bug",
                    body: "bad",
                    priority: "P0",
                    confidence: 0.9,
                    category: "bug",
                    code_location: { file_path: "a.ts", line: 1 },
                  },
                  {
                    title: "fake",
                    body: "meh",
                    priority: "P0",
                    confidence: 0.4,
                    category: "maintainability",
                    code_location: { file_path: "a.ts", line: 2 },
                  },
                ],
                overall_correctness: "patch is incorrect",
                overall_explanation: "two",
                overall_confidence: 0.7,
              }),
            };
          }
          return {
            text: JSON.stringify({
              decisions: [
                {
                  title: "real bug",
                  file_path: "a.ts",
                  line: 1,
                  outcome: "accept",
                  reason: "yes",
                },
                {
                  title: "fake",
                  file_path: "a.ts",
                  line: 2,
                  outcome: "reject",
                  reason: "style",
                },
              ],
              overall_explanation: "one stands",
            }),
          };
        },
      });
      expect(result.merged.findings).toHaveLength(1);
      expect(result.merged.findings[0]!.title).toBe("real bug");
      expect(result.markdown).toContain("Rejected by challenger");
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });
});
