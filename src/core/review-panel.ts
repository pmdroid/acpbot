/**
 * Two-reviewer panel / adversarial closeout orchestrator.
 * Pure control flow — caller injects how to run each reviewer turn.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReviewBundle,
  type BuildBundleOptions,
  type ReviewBundle,
} from "./review-bundle";
import {
  applyChallenge,
  buildChallengerPrompt,
  buildReviewerPrompt,
  filterReportByPriority,
  formatMergedReviewMarkdown,
  mergePanelReports,
  parseChallengeReport,
  parseReviewReport,
  type MergedReview,
  type ReviewFinding,
  type ReviewPriority,
  type ReviewReport,
  type ReviewerId,
} from "./review-schema";

export type ReviewProtocol = "panel" | "adversarial";

export type ReviewerSpec = {
  /** Registry agent id (codex, claude, …) */
  agent: string;
  /** Optional display label (defaults to agent) */
  label?: string;
};

export type RunReviewerTurn = (input: {
  agent: string;
  label: string;
  prompt: string;
  cwd: string;
  reviewId: string;
}) => Promise<{ text: string }>;

export type ReviewPanelInput = {
  cwd: string;
  stateDir: string;
  mode: "local" | "branch";
  base?: string;
  head?: string;
  protocol: ReviewProtocol;
  reviewers: [ReviewerSpec, ReviewerSpec];
  maxPriority?: ReviewPriority;
  timeoutSec?: number;
  runReviewer: RunReviewerTurn;
  onProgress?: (msg: string) => void | Promise<void>;
};

export type ReviewPanelResult = {
  bundle: ReviewBundle;
  protocol: ReviewProtocol;
  reviewers: string[];
  maxPriority: ReviewPriority;
  reports: Array<{ reviewer: ReviewerId; report?: ReviewReport; error?: string }>;
  merged: MergedReview;
  markdown: string;
  resultPath: string;
};

function labelOf(r: ReviewerSpec): string {
  return (r.label?.trim() || r.agent).trim();
}

/**
 * Freeze bundle, run two reviewers, merge (panel) or challenge (adversarial).
 */
export async function runReviewPanel(
  input: ReviewPanelInput,
): Promise<ReviewPanelResult> {
  const maxPriority = input.maxPriority ?? "P0";
  const [a, b] = input.reviewers;
  if (!a?.agent?.trim() || !b?.agent?.trim()) {
    throw new Error("two reviewers with agent ids are required");
  }
  const labels = [labelOf(a), labelOf(b)];

  const progress = async (msg: string) => {
    await input.onProgress?.(msg);
  };

  await progress("Freezing change bundle…");
  const bundleOpts: BuildBundleOptions = {
    cwd: input.cwd,
    stateDir: input.stateDir,
    mode: input.mode,
    ...(input.base !== undefined ? { base: input.base } : {}),
    ...(input.head !== undefined ? { head: input.head } : {}),
  };
  const bundle = buildReviewBundle(bundleOpts);

  if (bundle.empty) {
    const merged: MergedReview = {
      findings: [],
      overall: [],
      agreedCount: 0,
      uniqueCount: 0,
    };
    const markdown = formatMergedReviewMarkdown(merged, {
      targetLabel: bundle.label,
      reviewers: labels,
      protocol: input.protocol,
      maxPriority,
      empty: true,
    });
    const resultPath = join(bundle.dir, "result.json");
    writeFileSync(
      resultPath,
      JSON.stringify(
        {
          protocol: input.protocol,
          reviewers: labels,
          maxPriority,
          empty: true,
          merged,
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(join(bundle.dir, "result.md"), markdown, "utf8");
    return {
      bundle,
      protocol: input.protocol,
      reviewers: labels,
      maxPriority,
      reports: [],
      merged,
      markdown,
      resultPath,
    };
  }

  if (input.protocol === "adversarial") {
    return runAdversarial({
      bundle,
      finder: a,
      challenger: b,
      maxPriority,
      runReviewer: input.runReviewer,
      progress,
    });
  }

  // Independent panel
  await progress(`Running panel: ${labels[0]} ‖ ${labels[1]}…`);
  const prompt = buildReviewerPrompt({
    targetLabel: bundle.label,
    diffText: bundle.diffText,
    files: bundle.files,
    maxPriority,
    role: "panel",
  });

  const settled = await Promise.allSettled([
    input.runReviewer({
      agent: a.agent,
      label: labels[0]!,
      prompt,
      cwd: bundle.cwd,
      reviewId: bundle.id,
    }),
    input.runReviewer({
      agent: b.agent,
      label: labels[1]!,
      prompt,
      cwd: bundle.cwd,
      reviewId: bundle.id,
    }),
  ]);

  const reports: ReviewPanelResult["reports"] = [];
  const labeled: Array<{ reviewer: string; report: ReviewReport }> = [];

  for (let i = 0; i < 2; i++) {
    const lab = labels[i]!;
    const s = settled[i]!;
    if (s.status === "rejected") {
      const err = s.reason instanceof Error ? s.reason.message : String(s.reason);
      reports.push({ reviewer: lab, error: err });
      continue;
    }
    try {
      const report = filterReportByPriority(
        parseReviewReport(s.value.text),
        maxPriority,
      );
      reports.push({ reviewer: lab, report });
      labeled.push({ reviewer: lab, report });
    } catch (err) {
      reports.push({
        reviewer: lab,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (labeled.length === 0) {
    throw new Error(
      `both reviewers failed: ${reports.map((r) => `${r.reviewer}: ${r.error}`).join("; ")}`,
    );
  }

  const merged = mergePanelReports(labeled);
  const markdown = formatMergedReviewMarkdown(merged, {
    targetLabel: bundle.label,
    reviewers: labels,
    protocol: "panel",
    maxPriority,
  });
  const resultPath = join(bundle.dir, "result.json");
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        protocol: "panel",
        reviewers: labels,
        maxPriority,
        reports: reports.map((r) =>
          r.report
            ? { reviewer: r.reviewer, report: r.report }
            : { reviewer: r.reviewer, error: r.error },
        ),
        merged,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(bundle.dir, "result.md"), markdown, "utf8");

  return {
    bundle,
    protocol: "panel",
    reviewers: labels,
    maxPriority,
    reports,
    merged,
    markdown,
    resultPath,
  };
}

async function runAdversarial(input: {
  bundle: ReviewBundle;
  finder: ReviewerSpec;
  challenger: ReviewerSpec;
  maxPriority: ReviewPriority;
  runReviewer: RunReviewerTurn;
  progress: (msg: string) => Promise<void>;
}): Promise<ReviewPanelResult> {
  const finderLabel = labelOf(input.finder);
  const challengerLabel = labelOf(input.challenger);
  const labels = [finderLabel, challengerLabel];

  await input.progress(`Finder ${finderLabel}…`);
  const finderPrompt = buildReviewerPrompt({
    targetLabel: input.bundle.label,
    diffText: input.bundle.diffText,
    files: input.bundle.files,
    maxPriority: input.maxPriority,
    role: "finder",
  });
  const finderText = await input.runReviewer({
    agent: input.finder.agent,
    label: finderLabel,
    prompt: finderPrompt,
    cwd: input.bundle.cwd,
    reviewId: input.bundle.id,
  });
  const finderReport = filterReportByPriority(
    parseReviewReport(finderText.text),
    input.maxPriority,
  );

  await input.progress(`Challenger ${challengerLabel}…`);
  const challengePrompt = buildChallengerPrompt({
    targetLabel: input.bundle.label,
    diffText: input.bundle.diffText,
    finder: finderReport,
    finderLabel,
  });
  let challengeErr: string | undefined;
  let accepted = finderReport.findings;
  let rejected: Array<ReviewFinding & { reason: string }> = [];
  let challengeExplanation = "";

  try {
    const challengeText = await input.runReviewer({
      agent: input.challenger.agent,
      label: challengerLabel,
      prompt: challengePrompt,
      cwd: input.bundle.cwd,
      reviewId: input.bundle.id,
    });
    const challenge = parseChallengeReport(challengeText.text);
    challengeExplanation = challenge.overall_explanation;
    const applied = applyChallenge(finderReport, challenge);
    accepted = applied.accepted;
    rejected = applied.rejected;
  } catch (err) {
    challengeErr =
      err instanceof Error ? err.message : String(err);
    // Fail open to finder findings if challenger breaks — still labeled
  }

  const merged: MergedReview = {
    findings: accepted.map((f) => ({
      ...f,
      sources: challengeErr ? [finderLabel] : [finderLabel, challengerLabel],
      agreement: challengeErr ? "unique" : "agreed",
    })),
    overall: [
      {
        reviewer: finderLabel,
        overall_correctness: finderReport.overall_correctness,
        overall_explanation: finderReport.overall_explanation,
        overall_confidence: finderReport.overall_confidence,
      },
      {
        reviewer: challengerLabel,
        overall_correctness:
          accepted.length > 0 ? "patch is incorrect" : "patch is correct",
        overall_explanation:
          challengeExplanation ||
          (challengeErr
            ? `challenger failed: ${challengeErr}; showing finder findings only`
            : "challenge complete"),
        overall_confidence: challengeErr ? 0.3 : 0.7,
      },
    ],
    agreedCount: challengeErr ? 0 : accepted.length,
    uniqueCount: challengeErr ? accepted.length : 0,
  };

  let markdown = formatMergedReviewMarkdown(merged, {
    targetLabel: input.bundle.label,
    reviewers: labels,
    protocol: "adversarial",
    maxPriority: input.maxPriority,
  });
  if (rejected.length > 0) {
    markdown +=
      "\n\n### Rejected by challenger\n\n" +
      rejected
        .map(
          (r) =>
            `- **${r.title}** (\`${r.code_location.file_path}:${r.code_location.line}\`): ${r.reason}`,
        )
        .join("\n");
  }

  const reports: ReviewPanelResult["reports"] = [
    { reviewer: finderLabel, report: finderReport },
    challengeErr
      ? { reviewer: challengerLabel, error: challengeErr }
      : {
          reviewer: challengerLabel,
          report: {
            findings: accepted,
            overall_correctness:
              accepted.length > 0 ? "patch is incorrect" : "patch is correct",
            overall_explanation: challengeExplanation,
            overall_confidence: 0.7,
          },
        },
  ];

  const resultPath = join(input.bundle.dir, "result.json");
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        protocol: "adversarial",
        reviewers: labels,
        maxPriority: input.maxPriority,
        finder: finderReport,
        rejected,
        challengeError: challengeErr,
        merged,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(input.bundle.dir, "result.md"), markdown, "utf8");

  return {
    bundle: input.bundle,
    protocol: "adversarial",
    reviewers: labels,
    maxPriority: input.maxPriority,
    reports,
    merged,
    markdown,
    resultPath,
  };
}
