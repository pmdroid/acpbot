/**
 * Session compact prompts — durable memory lives **in the git repo**, under
 * `.acpbot/memory/` (not under host state_dir or a child worktree).
 */
import { join, resolve } from "node:path";

/** Safe filesystem segment from sessionKey (repo/name--child). */
export function memoryFileSlug(sessionKey: string): string {
  return (
    sessionKey
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "session"
  );
}

/**
 * Relative path from **repo root** for durable notes.
 * Always inside the repository: `.acpbot/memory/<slug>.md`
 */
export function sessionMemoryRelPath(sessionKey: string): string {
  return `.acpbot/memory/${memoryFileSlug(sessionKey)}.md`;
}

/** Absolute path under the configured repo root. */
export function sessionMemoryAbsPath(
  repoRoot: string,
  sessionKey: string,
): string {
  return join(resolve(repoRoot), sessionMemoryRelPath(sessionKey));
}

/**
 * Operator /compact prompt. Optional focus steers what to prioritize.
 * `repoRoot` must be the primary git repo path (not a child worktree).
 */
export function buildCompactPrompt(input: {
  sessionKey: string;
  /** Absolute primary repository root (from [repos]). */
  repoRoot: string;
  focus?: string;
}): string {
  const rel = sessionMemoryRelPath(input.sessionKey);
  const abs = sessionMemoryAbsPath(input.repoRoot, input.sessionKey);
  const focus = input.focus?.trim();
  const lines = [
    "You are compacting this acpbot session so a later turn (or scheduled job) can continue with a clean context.",
    "",
    "## Required: write durable memory **in the repository**",
    `1. Create or update this file **inside the git repo** (not a worktree-only or temp path):`,
    `   - relative: \`${rel}\``,
    `   - absolute: \`${abs}\``,
    `2. Repo root: \`${resolve(input.repoRoot)}\``,
    "3. Merge with any existing file — keep important facts, prune noise and one-off chatter.",
    "4. Structure the file with short sections, for example:",
    "   - Identity / purpose of this session",
    "   - Preferences and standing decisions",
    "   - People, projects, commitments",
    "   - Open loops / next actions",
    "   - Facts that must survive a new context window",
    "5. Be concise (bullets). Do not invent facts.",
    "6. After writing the file, reply to the operator with a short summary of what you stored (not the full file).",
    "",
  ];
  if (focus) {
    lines.push(`## Operator focus for this compact`, focus, "");
  } else {
    lines.push(
      "## Scope",
      "Compact the full useful session context (no extra operator focus).",
      "",
    );
  }
  lines.push(
    "Do not ask questions. Do the write into the repo path above, then give the short summary.",
  );
  return lines.join("\n");
}

/**
 * Prefix scheduled fires so life-assistant / long-lived agents refresh memory first.
 * Paths are relative to the **repo root** used by the scheduler.
 */
export function buildScheduleMemoryPreamble(input: {
  sessionKey: string;
  enabled?: boolean;
}): string[] {
  if (input.enabled === false) return [];
  const mem = sessionMemoryRelPath(input.sessionKey);
  return [
    "## Before the scheduled task (required)",
    "1. Read durable memory **in this repository** if it exists: `" +
      mem +
      "` (under the repo root, not a worktree-only path).",
    "2. Update that file with anything important from this session that should survive (merge, prune stale).",
    "3. Only after memory is written into the repo, execute the scheduled prompt below.",
    "",
  ];
}
