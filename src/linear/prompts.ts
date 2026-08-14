/**
 * Structured agent prompts for Linear topic workflows.
 * Slash commands inject these; the agent uses Linear MCP tools.
 */
import type { LinearProjectBinding } from "./bindings";
import {
  formatLinearBindingContext,
  withLinearStickyContext,
} from "./bindings";

export function linearExportPrompt(
  binding: LinearProjectBinding | undefined,
): string {
  const context = formatLinearBindingContext(binding);
  return [
    "You are exporting the agreed plan from this Telegram topic into Linear.",
    "",
    context,
    "",
    "Steps:",
    "1. Summarize the plan as a proposed Linear project: name, short description,",
    "   milestones (only if the plan has clear phases), and a list of issues with",
    "   titles + descriptions (problem, goal, approach, open questions).",
    "2. Show the proposal to the operator and wait for confirmation before creating",
    "   anything. Do not invent structure the plan does not support.",
    "3. After confirmation, create the project and issues using **Linear MCP** tools",
    "   (server id `linear`). Prefer the team the operator names if any.",
    "4. When create succeeds, call host MCP `linear_bind_project` with projectId,",
    "   projectName, projectUrl (if known), teamId/teamKey so this topic stays bound.",
    "5. Reply with project URL/id and issue identifiers.",
    "",
    "If Linear MCP tools are missing, tell the operator to run `/linear connect`.",
  ].join("\n");
}

/**
 * One-issue-at-a-time backlog step. Operator invoked `/linear next` →
 * implicit consent to start the best next issue (no second OK unless ambiguous).
 */
export function linearNextPrompt(
  binding: LinearProjectBinding | undefined,
): string {
  const context = formatLinearBindingContext(binding);
  return [
    "Continue the bound Linear project — **exactly one issue this turn**.",
    "",
    context,
    "",
    "Rules (status hygiene):",
    "- Scope: only open (non-done / non-canceled) issues in the **bound** project.",
    "- Work **one** issue end-to-end. Do not start a second issue in this turn.",
    "- Operator ran `/linear next` → pick the best next issue and **proceed** unless",
    "  two candidates are equally good; then ask once which to take.",
    "- Prefer: unblocked, highest priority, then oldest / cycle order.",
    "- If lastIssueId is set and still open, consider finishing it before picking another.",
    "",
    "Steps:",
    "1. `linear_get_binding` (confirm project id).",
    "2. Linear MCP: list open issues in that project only.",
    "3. Choose one issue. Load full description + acceptance criteria.",
    "4. Set status **In Progress** (if not already). Comment that work started in acpbot.",
    "5. `linear_bind_project` with same projectId and `lastIssueId` set to this issue.",
    "6. Implement in this repo. Use `update` after major steps.",
    "7. When done: Linear comment (what changed, files/branch/PR if any) → status **Done**",
    "   (or leave In Progress + comment blocker if stuck — do not mark Done).",
    "8. Summarize for the operator. Suggest `/linear next` for the following issue.",
    "",
    "If Linear MCP tools are missing, tell the operator to run `/linear connect`.",
  ].join("\n");
}

export function linearWorkPrompt(
  issueRef: string,
  binding: LinearProjectBinding | undefined,
): string {
  const context = formatLinearBindingContext(binding);
  const issue = issueRef.trim();
  return [
    `Work Linear issue **${issue}** as the **only** focus this turn.`,
    "",
    context,
    "",
    "Rules:",
    "- Do not start other issues until this one is Done, blocked, or the operator redirects.",
    "- Stay on the bound project; if this issue is outside it, warn and confirm before continuing.",
    "",
    "Steps:",
    "1. Load the issue via Linear MCP (by id/identifier). If not found, say so and stop.",
    "2. Summarize goal + acceptance criteria for the operator (brief).",
    "3. Set status **In Progress**; comment that work started in acpbot.",
    "4. `linear_bind_project` with `lastIssueId` = this issue (keep project fields).",
    "5. Implement in this repo. Keep the operator updated with `update`.",
    "6. When done: comment summary (files/PR/branch if any), mark **Done** (or request review).",
    "   If blocked: comment the blocker, leave status appropriate, do not mark Done.",
    "7. Reply with issue id + outcome.",
    "",
    "If Linear MCP tools are missing, tell the operator to run `/linear connect`.",
  ].join("\n");
}

/**
 * Multi-agent fan-out: parent hub spawns one child per open issue.
 */
export function linearFanoutPrompt(
  binding: LinearProjectBinding | undefined,
): string {
  const context = formatLinearBindingContext(binding);
  return [
    "Fan out the bound Linear project across child agents (multi-agent).",
    "",
    context,
    "",
    "Rules:",
    "- Require a bound project; if missing, stop and ask for `/linear project` or `/linear export`.",
    "- List **open** issues in that project only.",
    "- Show the planned spawn list (issue id + slug) and wait for operator confirmation",
    "  before spawning (unless they already said “fan out now” / proceed).",
    "- Respect spawn caps (`[agents.spawn]`); if more issues than max children, spawn a batch",
    "  and note what remains.",
    "- Parent is the A2A hub only — no sibling mesh.",
    "- Parent cwd is never shared; each child gets a worktree.",
    "",
    "Per issue:",
    "1. `agent_spawn` with a stable slug (e.g. issue identifier lowercased).",
    "2. Kickoff prompt must include: issue id, title, description, acceptance criteria,",
    "   and “implement only this issue; report files changed; do not touch other issues.”",
    "3. Prefer `headless: true` (default) so permissions stay on this parent topic.",
    "",
    "After spawns:",
    "4. `agent_wait` (or wait in parallel where tools allow) per child.",
    "5. On child success: Linear comment + mark issue **Done** (or In Review if appropriate).",
    "6. On child failure: Linear comment with summary; leave issue open / blocked.",
    "7. Summarize all outcomes to the operator.",
    "",
    "If `agent_*` tools are missing, fall back to sequential `/linear work` style in this topic.",
    "If Linear MCP is missing, tell the operator to run `/linear connect`.",
  ].join("\n");
}

/**
 * Background drain via EVE — agent authors the directive (no shipped script).
 */
export function linearDrainPrompt(
  binding: LinearProjectBinding | undefined,
  options?: { sequential?: boolean },
): string {
  const context = formatLinearBindingContext(binding);
  const sequential = options?.sequential === true;
  return [
    "Drain the bound Linear project in the **background** using **EVE**.",
    "There is **no built-in drain script** — you must **author** an EVE directive,",
    "save it, and start it. Follow the **eve** skill.",
    "",
    context,
    "",
    "Steps:",
    "1. `linear_get_binding` — stop if no bound project.",
    "2. Design a JS EVE directive (Discover → Implement → Close):",
    "   - Discover: one `agent()` that lists open issues in the **bound project only**",
    "     via Linear MCP; return schema `{ issues: [{ id, identifier, title, body, blockedBy[] }] }`.",
    "   - Filter ready issues (`blockedBy` empty); cap with `args.maxIssues` (default 20).",
    "   - Implement: `pipeline` (or sequential loop + `budget.ok()`) one leaf `agent()` per",
    "     ready issue — implement **only** that issue; schema `{ status: done|blocked, summary, prUrl? }`.",
    sequential
      ? "   - Operator asked for **sequential** work (`--sequential`): loop with `await agent(...)` per issue, not parallel pipeline fan-out."
      : "   - Prefer `pipeline` for concurrent ready issues (host caps concurrency).",
    "   - Close: `host.linearApplyResults(results)` if available, else one final agent to",
    "     comment + set Done/blocked on Linear. If any leaf is blocked, `await host.ask`",
    "     (retry / continue / stop) before returning — never treat blocked as success.",
    "3. `eve_write({ name: \"linear-drain\", source: <full script with export const meta> })`",
    "   (reuse/update the project script if it already exists).",
    "4. `eve_run({ name: \"linear-drain\", args: {",
    "     projectId, projectName, maxIssues: 20" +
      (sequential ? ", sequential: true" : "") +
      " } })`.",
    "5. Tell the operator: run id, `/eve approve <runId>` if pending, `/eve status <runId>`.",
    "   Do **not** sit in chat implementing every issue yourself.",
    "",
    "If EVE tools (`eve_write` / `eve_run`) are missing, say so and fall back to explaining",
    "`/linear next` / `/linear fanout`. If Linear MCP is missing: `/linear connect`.",
  ].join("\n");
}

export function linearProjectPickPrompt(): string {
  return [
    "Help the operator bind this Telegram topic to a Linear project.",
    "",
    "1. Using Linear MCP, list recent/active projects (and teams if needed).",
    "2. Present a short numbered list (name + id + url when available).",
    "3. Ask which project to bind (or offer to create one from the plan).",
    "4. After the operator chooses, call `linear_bind_project` with projectId and metadata.",
    "5. Confirm the binding in your reply.",
    "",
    "If Linear MCP tools are missing, tell the operator to run `/linear connect`.",
  ].join("\n");
}

/** Apply sticky Linear context for free-text turns (no-op if already tagged). */
export function applyLinearTurnContext(
  agentText: string,
  binding: LinearProjectBinding | undefined,
): string {
  return withLinearStickyContext(agentText, binding);
}

export const LINEAR_COMMAND_USAGE = [
  "**Linear** — topic ↔ project; agent works the backlog via Linear MCP.",
  "",
  "`/linear` — status (OAuth + bound project)",
  "`/linear connect` — add official Linear MCP + start OAuth",
  "`/linear disconnect` — drop OAuth token (optional: `remove` drops mcp.json entry)",
  "`/linear project` — show binding, or agent-assisted pick",
  "`/linear project <id|url|name>` — bind this topic to a project",
  "`/linear unbind` — clear topic binding only",
  "`/linear export` — agent: plan → Linear project + issues + bind",
  "`/linear next` — agent: **one** next open issue (In Progress → implement → Done)",
  "`/linear work <ISSUE>` — agent: focus one issue",
  "`/linear fanout` — agent: multi-agent one child per open issue",
  "`/linear drain` — agent: **write + run** an EVE drain directive (no built-in script)",
].join("\n");
