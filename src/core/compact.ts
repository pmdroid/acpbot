/**
 * Session compact prompts — durable memory for long-lived / life-assistant agents.
 */

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

/** Relative path under session repo root for durable notes. */
export function sessionMemoryRelPath(sessionKey: string): string {
  return `.acpbot/memory/${memoryFileSlug(sessionKey)}.md`;
}

/**
 * Operator /compact prompt. Optional focus steers what to prioritize.
 */
export function buildCompactPrompt(input: {
  sessionKey: string;
  cwd: string;
  focus?: string;
}): string {
  const mem = sessionMemoryRelPath(input.sessionKey);
  const focus = input.focus?.trim();
  const lines = [
    "You are compacting this acpbot session so a later turn (or scheduled job) can continue with a clean context.",
    "",
    "## Required: write durable memory",
    `1. Create or update the markdown file \`${mem}\` under the session cwd (\`${input.cwd}\`).`,
    "2. Merge with any existing file — keep important facts, prune noise and one-off chatter.",
    "3. Structure the file with short sections, for example:",
    "   - Identity / purpose of this session",
    "   - Preferences and standing decisions",
    "   - People, projects, commitments",
    "   - Open loops / next actions",
    "   - Facts that must survive a new context window",
    "4. Be concise (bullets). Do not invent facts.",
    "5. After writing the file, reply to the operator with a short summary of what you stored (not the full file).",
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
    "Do not ask questions. Do the write, then give the short summary.",
  );
  return lines.join("\n");
}

/**
 * Prefix scheduled fires so life-assistant / long-lived agents refresh memory first.
 */
export function buildScheduleMemoryPreamble(input: {
  sessionKey: string;
  enabled?: boolean;
}): string[] {
  if (input.enabled === false) return [];
  const mem = sessionMemoryRelPath(input.sessionKey);
  return [
    "## Before the scheduled task (required)",
    "1. Read durable memory if it exists: `" + mem + "`.",
    "2. Update that file with anything important from the current session that should survive (merge, prune stale).",
    "3. Only after memory is written, execute the scheduled prompt below.",
    "",
  ];
}
