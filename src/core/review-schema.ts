/**
 * Structured review report schema + merge helpers.
 * Host validates reviewer JSON before showing digests to the operator.
 *
 * Finding shape / panel contract inspired by OpenClaw autoreview:
 * https://github.com/openclaw/agent-skills/tree/main/skills/autoreview
 */

import { parseAgentStructuredResult, validateJsonSchema } from "../eve/schema";

export type ReviewPriority = "P0" | "P1" | "P2" | "P3";

export type ReviewCategory =
  | "bug"
  | "security"
  | "regression"
  | "test_gap"
  | "maintainability";

export type ReviewFinding = {
  title: string;
  body: string;
  priority: ReviewPriority;
  confidence: number;
  category: ReviewCategory;
  code_location: { file_path: string; line: number };
};

export type ReviewReport = {
  findings: ReviewFinding[];
  overall_correctness: "patch is correct" | "patch is incorrect";
  overall_explanation: string;
  overall_confidence: number;
};

export type ReviewerId = string;

export type LabeledReport = {
  reviewer: ReviewerId;
  report: ReviewReport;
};

export type MergedFinding = ReviewFinding & {
  /** Reviewers that raised this finding (agreed if >1). */
  sources: ReviewerId[];
  agreement: "agreed" | "unique";
};

export type MergedReview = {
  findings: MergedFinding[];
  overall: Array<{
    reviewer: ReviewerId;
    overall_correctness: ReviewReport["overall_correctness"];
    overall_explanation: string;
    overall_confidence: number;
  }>;
  agreedCount: number;
  uniqueCount: number;
};

export const REVIEW_REPORT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: [
    "findings",
    "overall_correctness",
    "overall_explanation",
    "overall_confidence",
  ],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: [
          "title",
          "body",
          "priority",
          "confidence",
          "category",
          "code_location",
        ],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          priority: {
            type: "string",
            enum: ["P0", "P1", "P2", "P3"],
          },
          confidence: { type: "number" },
          category: {
            type: "string",
            enum: [
              "bug",
              "security",
              "regression",
              "test_gap",
              "maintainability",
            ],
          },
          code_location: {
            type: "object",
            required: ["file_path", "line"],
            properties: {
              file_path: { type: "string" },
              line: { type: "integer" },
            },
          },
        },
      },
    },
    overall_correctness: {
      type: "string",
      enum: ["patch is correct", "patch is incorrect"],
    },
    overall_explanation: { type: "string" },
    overall_confidence: { type: "number" },
  },
};

const PRIORITY_RANK: Record<ReviewPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export function priorityAtMost(
  priority: ReviewPriority,
  max: ReviewPriority,
): boolean {
  return PRIORITY_RANK[priority] <= PRIORITY_RANK[max];
}

export function filterReportByPriority(
  report: ReviewReport,
  max: ReviewPriority,
): ReviewReport {
  return {
    ...report,
    findings: report.findings.filter((f) => priorityAtMost(f.priority, max)),
  };
}

/** Normalize loosely-typed model output into a ReviewReport or throw. */
export function coerceReviewReport(raw: unknown): ReviewReport {
  const v = validateJsonSchema(REVIEW_REPORT_JSON_SCHEMA, raw);
  if (!v.ok) throw new Error(v.error);

  const o = raw as Record<string, unknown>;
  const findingsIn = Array.isArray(o.findings) ? o.findings : [];
  const findings: ReviewFinding[] = findingsIn.map((item, i) => {
    const f = item as Record<string, unknown>;
    const loc = f.code_location as Record<string, unknown>;
    const conf = Number(f.confidence);
    return {
      title: String(f.title ?? "").trim() || `finding-${i + 1}`,
      body: String(f.body ?? "").trim() || "(no detail)",
      priority: f.priority as ReviewPriority,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
      category: f.category as ReviewCategory,
      code_location: {
        file_path: String(loc?.file_path ?? "").trim() || "unknown",
        line: Math.max(1, Math.floor(Number(loc?.line) || 1)),
      },
    };
  });

  const overallConf = Number(o.overall_confidence);
  return {
    findings,
    overall_correctness: o.overall_correctness as ReviewReport["overall_correctness"],
    overall_explanation: String(o.overall_explanation ?? "").trim() || "(none)",
    overall_confidence: Number.isFinite(overallConf)
      ? Math.min(1, Math.max(0, overallConf))
      : 0.5,
  };
}

/** Parse agent text → validated ReviewReport. */
export function parseReviewReport(text: string): ReviewReport {
  const parsed = parseAgentStructuredResult(text);
  if (parsed == null) {
    throw new Error("no JSON object found in reviewer output");
  }
  return coerceReviewReport(parsed);
}

function findingKey(f: ReviewFinding): string {
  const file = f.code_location.file_path.replace(/\\/g, "/").toLowerCase();
  const title = f.title.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
  return `${file}:${f.code_location.line}:${title}`;
}

/**
 * Merge independent panel reports.
 * Same file:line + similar title → agreed; otherwise unique to one reviewer.
 */
export function mergePanelReports(labeled: LabeledReport[]): MergedReview {
  const byKey = new Map<
    string,
    { finding: ReviewFinding; sources: Set<ReviewerId> }
  >();

  for (const { reviewer, report } of labeled) {
    for (const f of report.findings) {
      const key = findingKey(f);
      const existing = byKey.get(key);
      if (existing) {
        existing.sources.add(reviewer);
        // Prefer higher confidence / worse priority
        if (f.confidence > existing.finding.confidence) {
          existing.finding = f;
        } else if (
          PRIORITY_RANK[f.priority] < PRIORITY_RANK[existing.finding.priority]
        ) {
          existing.finding = f;
        }
      } else {
        byKey.set(key, { finding: f, sources: new Set([reviewer]) });
      }
    }
  }

  const findings: MergedFinding[] = [...byKey.values()].map((row) => {
    const sources = [...row.sources];
    return {
      ...row.finding,
      sources,
      agreement: sources.length > 1 ? "agreed" : "unique",
    };
  });

  findings.sort((a, b) => {
    if (a.agreement !== b.agreement) {
      return a.agreement === "agreed" ? -1 : 1;
    }
    if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) {
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    }
    return b.confidence - a.confidence;
  });

  return {
    findings,
    overall: labeled.map((l) => ({
      reviewer: l.reviewer,
      overall_correctness: l.report.overall_correctness,
      overall_explanation: l.report.overall_explanation,
      overall_confidence: l.report.overall_confidence,
    })),
    agreedCount: findings.filter((f) => f.agreement === "agreed").length,
    uniqueCount: findings.filter((f) => f.agreement === "unique").length,
  };
}

/**
 * Adversarial challenge schema: challenger accepts/rejects each finding.
 */
export type ChallengeDecision = {
  title: string;
  file_path: string;
  line: number;
  outcome: "accept" | "reject";
  reason: string;
};

export type ChallengeReport = {
  decisions: ChallengeDecision[];
  overall_explanation: string;
};

export const CHALLENGE_REPORT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["decisions", "overall_explanation"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "file_path", "line", "outcome", "reason"],
        properties: {
          title: { type: "string" },
          file_path: { type: "string" },
          line: { type: "integer" },
          outcome: { type: "string", enum: ["accept", "reject"] },
          reason: { type: "string" },
        },
      },
    },
    overall_explanation: { type: "string" },
  },
};

export function parseChallengeReport(text: string): ChallengeReport {
  const parsed = parseAgentStructuredResult(text);
  if (parsed == null) {
    throw new Error("no JSON object found in challenger output");
  }
  const v = validateJsonSchema(CHALLENGE_REPORT_JSON_SCHEMA, parsed);
  if (!v.ok) throw new Error(v.error);
  const o = parsed as Record<string, unknown>;
  const decisions = (Array.isArray(o.decisions) ? o.decisions : []).map(
    (d) => {
      const x = d as Record<string, unknown>;
      return {
        title: String(x.title ?? "").trim(),
        file_path: String(x.file_path ?? "").trim(),
        line: Math.max(1, Math.floor(Number(x.line) || 1)),
        outcome: x.outcome as "accept" | "reject",
        reason: String(x.reason ?? "").trim() || "(no reason)",
      };
    },
  );
  return {
    decisions,
    overall_explanation:
      String(o.overall_explanation ?? "").trim() || "(none)",
  };
}

/** Apply challenge decisions to finder findings (default reject if missing). */
export function applyChallenge(
  finder: ReviewReport,
  challenge: ChallengeReport,
  opts?: { defaultOutcome?: "accept" | "reject" },
): { accepted: ReviewFinding[]; rejected: Array<ReviewFinding & { reason: string }> } {
  const def = opts?.defaultOutcome ?? "reject";
  const byKey = new Map<string, ChallengeDecision>();
  for (const d of challenge.decisions) {
    const key = `${d.file_path.replace(/\\/g, "/").toLowerCase()}:${d.line}:${d.title.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80)}`;
    byKey.set(key, d);
  }
  const accepted: ReviewFinding[] = [];
  const rejected: Array<ReviewFinding & { reason: string }> = [];
  for (const f of finder.findings) {
    const key = findingKey(f);
    const d = byKey.get(key);
    const outcome = d?.outcome ?? def;
    if (outcome === "accept") accepted.push(f);
    else
      rejected.push({
        ...f,
        reason: d?.reason ?? "challenger did not address this finding",
      });
  }
  return { accepted, rejected };
}

export function formatMergedReviewMarkdown(
  merged: MergedReview,
  meta: {
    targetLabel: string;
    reviewers: string[];
    protocol: string;
    maxPriority: ReviewPriority;
    empty?: boolean;
  },
): string {
  const lines: string[] = [
    `## Review · ${meta.targetLabel}`,
    "",
    `- **Protocol:** ${meta.protocol}`,
    `- **Reviewers:** ${meta.reviewers.join(" · ")}`,
    `- **Max priority:** ${meta.maxPriority}`,
    `- **Findings:** ${merged.findings.length} (${merged.agreedCount} agreed · ${merged.uniqueCount} unique)`,
    "",
  ];

  if (meta.empty) {
    lines.push("_No changes in the frozen bundle — nothing to review._");
    return lines.join("\n");
  }

  for (const o of merged.overall) {
    lines.push(
      `### ${o.reviewer} — ${o.overall_correctness} (confidence ${o.overall_confidence.toFixed(2)})`,
    );
    lines.push(o.overall_explanation);
    lines.push("");
  }

  if (merged.findings.length === 0) {
    lines.push("**No accepted/actionable findings at this priority.**");
    return lines.join("\n");
  }

  lines.push("### Findings");
  lines.push("");
  merged.findings.forEach((f, i) => {
    const tag = f.agreement === "agreed" ? "AGREED" : "UNIQUE";
    lines.push(
      `**${i + 1}. [${f.priority}] [${tag}] ${f.title}** — \`${f.code_location.file_path}:${f.code_location.line}\``,
    );
    lines.push(
      `sources: ${f.sources.join(", ")} · ${f.category} · conf ${f.confidence.toFixed(2)}`,
    );
    lines.push(f.body);
    lines.push("");
  });

  lines.push(
    "_Advisory only — verify every finding in real code before applying fixes._",
  );
  return lines.join("\n");
}

/** Prompt body shared by panel reviewers. */
export function buildReviewerPrompt(input: {
  targetLabel: string;
  diffText: string;
  files: string[];
  maxPriority: ReviewPriority;
  role: "finder" | "panel";
}): string {
  const schemaJson = JSON.stringify(REVIEW_REPORT_JSON_SCHEMA, null, 2);
  const filesList =
    input.files.length > 0
      ? input.files.slice(0, 200).map((f) => `- ${f}`).join("\n")
      : "(none listed)";
  return [
    "You are a careful code reviewer. This is a closeout / second-opinion review.",
    "Do NOT modify files. Do NOT run nested reviews or spawn other reviewers.",
    "Verify claims against the diff and surrounding source when needed.",
    "Default to material blockers only unless a wider priority is allowed.",
    `Report findings at priority ${input.maxPriority} or worse (P0 is worst).`,
    `Target: ${input.targetLabel}`,
    "",
    "Changed files:",
    filesList,
    "",
    "Unified diff (frozen bundle — sole patch under review):",
    "```diff",
    input.diffText.slice(0, 350_000),
    "```",
    "",
    "Return ONLY a single JSON object matching this schema (optional ```json fence):",
    schemaJson,
    "",
    "Rules:",
    "- Empty findings[] is fine if the patch looks correct.",
    "- code_location.line is the line in the NEW file when possible.",
    "- Prefer concrete bugs/security/regressions over style nits.",
    "- overall_correctness must be set honestly.",
  ].join("\n");
}

export function buildChallengerPrompt(input: {
  targetLabel: string;
  diffText: string;
  finder: ReviewReport;
  finderLabel: string;
}): string {
  const schemaJson = JSON.stringify(CHALLENGE_REPORT_JSON_SCHEMA, null, 2);
  return [
    "You are an adversarial challenger reviewing another model's findings.",
    "Do NOT modify files. Do NOT invent new findings.",
    "For each finding below: accept only if it is real, actionable, and material.",
    "Reject speculative risks, style nits, and incorrect claims.",
    `Target: ${input.targetLabel}`,
    `Finder: ${input.finderLabel}`,
    "",
    "Finder report JSON:",
    "```json",
    JSON.stringify(input.finder, null, 2),
    "```",
    "",
    "Unified diff:",
    "```diff",
    input.diffText.slice(0, 350_000),
    "```",
    "",
    "Return ONLY JSON matching this schema:",
    schemaJson,
  ].join("\n");
}
