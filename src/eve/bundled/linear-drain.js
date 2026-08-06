/**
 * Bundled EVE directive: drain open Linear issues (ready set).
 * Args: { projectId?, maxIssues?, agent?, sequential? }
 */
export const meta = {
  name: "linear-drain",
  description:
    "Work unblocked open Linear issues in the bound project until dry (or maxIssues)",
  phases: [
    { title: "Discover" },
    { title: "Implement" },
    { title: "Close" },
  ],
};

phase("Discover");

const maxIssues =
  args && typeof args.maxIssues === "number" ? args.maxIssues : 20;
const agentName =
  args && typeof args.agent === "string" ? args.agent : undefined;
const sequential = args && args.sequential === true;

const listed = await agent(
  [
    "List open (non-done, non-canceled) issues in the **bound Linear project** only.",
    "Use Linear MCP tools. If no binding, fail clearly.",
    "For each issue include: id, identifier, title, body (description), blockedBy (array of identifiers still open).",
    "Prefer highest priority, then oldest.",
    `Return at most ${maxIssues} issues.`,
  ].join("\n"),
  {
    phase: "Discover",
    label: "list-issues",
    schema: {
      type: "object",
      required: ["issues"],
      properties: {
        issues: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "identifier", "title", "body", "blockedBy"],
            properties: {
              id: { type: "string" },
              identifier: { type: "string" },
              title: { type: "string" },
              body: { type: "string" },
              blockedBy: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
);

if (!listed || !listed.issues) {
  log("No issues payload — stopping");
  return { done: 0, blocked: 0, error: "list failed" };
}

const ready = listed.issues
  .filter((i) => !i.blockedBy || i.blockedBy.length === 0)
  .slice(0, maxIssues);

log(`Found ${listed.issues.length} open · ${ready.length} ready`);

if (ready.length === 0) {
  phase("Close");
  return { done: 0, blocked: 0, message: "no ready issues" };
}

phase("Implement");

const ISSUE_RESULT = {
  type: "object",
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["done", "blocked"] },
    summary: { type: "string" },
    prUrl: { type: "string" },
    branch: { type: "string" },
  },
};

async function workIssue(issue) {
  return agent(
    [
      `Implement ONLY Linear issue ${issue.identifier}: ${issue.title}`,
      "",
      issue.body || "(no description)",
      "",
      "Rules:",
      "- Stay in this worktree; do not start other issues.",
      "- Set Linear status In Progress, implement, comment outcome.",
      "- Mark Done only if acceptance criteria met; else status blocked + comment.",
      "- Open a PR if appropriate and include prUrl/branch in the JSON result.",
    ].join("\n"),
    {
      phase: "Implement",
      label: String(issue.identifier).toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
      agent: agentName,
      isolation: "worktree",
      role: "implementer",
      schema: ISSUE_RESULT,
      timeout_sec: 1200,
    },
  );
}

let results;
if (sequential) {
  results = [];
  for (const issue of ready) {
    if (!budget.ok()) break;
    results.push(await workIssue(issue));
  }
} else {
  results = await pipeline(ready, async (_prev, issue) => workIssue(issue));
}

phase("Close");

const ok = (results || []).filter(Boolean);
const done = ok.filter((r) => r && r.status === "done").length;
const blocked = ok.filter((r) => r && r.status === "blocked").length;

log(`Close: ${done} done · ${blocked} blocked · ${ok.length} reported`);

// Prefer host helper when available (no LLM)
if (host && typeof host.linearApplyResults === "function") {
  try {
    await host.linearApplyResults(ok);
  } catch (e) {
    log(`linearApplyResults skipped: ${e && e.message ? e.message : e}`);
  }
} else {
  await agent(
    [
      "Update Linear for the following issue outcomes (comment + Done/blocked).",
      "Only issues you can map from the summaries:",
      JSON.stringify(ok, null, 2),
    ].join("\n"),
    { phase: "Close", label: "linear-close" },
  );
}

return {
  done,
  blocked,
  totalReady: ready.length,
  results: ok,
};
