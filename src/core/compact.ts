/**
 * Session compact prompts — prefer MCP memory_* tools; files live in the **repo**.
 */
import { resolve } from "node:path";
import {
  memoryAbsPath,
  memoryFileSlug,
  memoryRelPath,
  todayUtcDate,
} from "./memory";

export { memoryFileSlug } from "./memory";

/** Legacy path helper (session working notes). */
export function sessionMemoryRelPath(sessionKey: string): string {
  return memoryRelPath("session", { sessionKey });
}

export function sessionMemoryAbsPath(
  repoRoot: string,
  sessionKey: string,
): string {
  return memoryAbsPath(repoRoot, "session", { sessionKey });
}

/**
 * Operator /compact prompt. Prefer memory_write / memory_read tools.
 * `repoRoot` must be the primary git repo path (not a child worktree).
 */
export function buildCompactPrompt(input: {
  sessionKey: string;
  /** Absolute primary repository root (from [repos]). */
  repoRoot: string;
  focus?: string;
}): string {
  const daily = memoryRelPath("daily", { date: todayUtcDate() });
  const curated = memoryRelPath("memory");
  const user = memoryRelPath("user");
  const sessionNote = memoryRelPath("session", {
    sessionKey: input.sessionKey,
  });
  const dailyAbs = memoryAbsPath(input.repoRoot, "daily", {
    date: todayUtcDate(),
  });
  const curatedAbs = memoryAbsPath(input.repoRoot, "memory");
  const focus = input.focus?.trim();
  const lines = [
    "You are compacting this acpbot session so later turns keep durable context.",
    "",
    "## Required: use acpbot memory tools (repo-local)",
    "Call the **acpbot** MCP tools (not raw write to random paths):",
    "- `memory_write` — persist facts",
    "- `memory_read` — load existing notes before merging",
    "",
    `Repo root: \`${resolve(input.repoRoot)}\``,
    "",
    "### Where to write (inside the git repo)",
    "| Layer | section | File |",
    "|---|---|---|",
    `| Episodic / today | \`daily\` | \`${daily}\` |`,
    `| Curated long-term | \`memory\` | \`${curated}\` |`,
    `| Preferences | \`user\` | \`${user}\` |`,
    `| This topic (optional) | \`session\` | \`${sessionNote}\` |`,
    "",
    "Absolute examples:",
    `- \`${dailyAbs}\``,
    `- \`${curatedAbs}\``,
    "",
    "### Steps",
    "1. `memory_read` section=memory and section=daily (today).",
    "2. `memory_write` section=daily — append a short session summary (mode=append).",
    "3. `memory_write` section=memory — merge durable facts only (append bullets; use replace only when carefully rewriting).",
    "4. If preferences changed: `memory_write` section=user.",
    "5. Reply to the operator with a short summary of what you stored (paths + bullets), not the full files.",
    "",
    "Rules: concise; do not invent facts; do not dump full chat transcripts into MEMORY.md.",
  ];
  if (focus) {
    lines.push("", `## Operator focus for this compact`, focus);
  } else {
    lines.push(
      "",
      "## Scope",
      "Compact the full useful session context (no extra operator focus).",
    );
  }
  lines.push(
    "",
    "Do not ask questions. Use memory_write/read, then summarize.",
  );
  return lines.join("\n");
}
