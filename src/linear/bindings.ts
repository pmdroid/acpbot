/**
 * Per-session Linear project bindings (topic ↔ project).
 *
 * Tokens stay under mcp-oauth; this store only remembers which Linear project
 * a Telegram topic is working through. Never write under the git repo.
 *
 * Layout:
 *   $state_dir/linear/bindings/<encodedSessionKey>.json
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveStateDir } from "../env/state-dir";

export type LinearBoundBy = "export" | "attach" | "agent" | "command";

export type LinearProjectBinding = {
  sessionKey: string;
  repoKey: string;
  projectId: string;
  projectName?: string;
  projectUrl?: string;
  teamId?: string;
  teamKey?: string;
  boundAt: string;
  boundBy: LinearBoundBy;
  /** Optional last-focused issue identifier (ENG-123). */
  lastIssueId?: string;
};

export type SaveLinearBindingInput = {
  sessionKey: string;
  repoKey: string;
  projectId: string;
  projectName?: string;
  projectUrl?: string;
  teamId?: string;
  teamKey?: string;
  boundBy?: LinearBoundBy;
  lastIssueId?: string;
};

function fileNameFor(sessionKey: string): string {
  return `${encodeURIComponent(sessionKey)}.json`;
}

export function linearBindingsDir(stateDir: string): string {
  return join(resolveStateDir(stateDir), "linear", "bindings");
}

function pathFor(stateDir: string, sessionKey: string): string {
  return join(linearBindingsDir(stateDir), fileNameFor(sessionKey));
}

function isBinding(value: unknown): value is LinearProjectBinding {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.sessionKey === "string" &&
    typeof o.repoKey === "string" &&
    typeof o.projectId === "string" &&
    typeof o.boundAt === "string" &&
    typeof o.boundBy === "string"
  );
}

/** Parse project id / url / free text into binding fields. */
export function parseLinearProjectRef(input: string): {
  projectId: string;
  projectUrl?: string;
  projectName?: string;
} {
  const raw = input.trim();
  if (!raw) throw new Error("project ref is empty");

  // Full Linear URL
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`invalid Linear project URL: ${raw}`);
    }
    const projectUrl = url.toString();
    // Prefer a UUID in the path/query
    const uuidMatch = projectUrl.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    if (uuidMatch) {
      return { projectId: uuidMatch[0], projectUrl };
    }
    // Fall back to last non-empty path segment (slug)
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) {
      return { projectId: decodeURIComponent(last), projectUrl };
    }
    throw new Error(`could not extract project id from URL: ${raw}`);
  }

  // Bare UUID
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      raw,
    )
  ) {
    return { projectId: raw };
  }

  // Name or opaque id — store as both id and name; agent/MCP can resolve.
  return { projectId: raw, projectName: raw };
}

export async function loadLinearBinding(
  stateDir: string,
  sessionKey: string,
): Promise<LinearProjectBinding | undefined> {
  const file = pathFor(stateDir, sessionKey);
  try {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isBinding(parsed) ? parsed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function saveLinearBinding(
  stateDir: string,
  input: SaveLinearBindingInput,
): Promise<LinearProjectBinding> {
  const sessionKey = input.sessionKey.trim();
  const repoKey = input.repoKey.trim();
  const projectId = input.projectId.trim();
  if (!sessionKey) throw new Error("sessionKey is required");
  if (!repoKey) throw new Error("repoKey is required");
  if (!projectId) throw new Error("projectId is required");

  const record: LinearProjectBinding = {
    sessionKey,
    repoKey,
    projectId,
    boundAt: new Date().toISOString(),
    boundBy: input.boundBy ?? "command",
  };
  if (input.projectName?.trim()) record.projectName = input.projectName.trim();
  if (input.projectUrl?.trim()) record.projectUrl = input.projectUrl.trim();
  if (input.teamId?.trim()) record.teamId = input.teamId.trim();
  if (input.teamKey?.trim()) record.teamKey = input.teamKey.trim();
  if (input.lastIssueId?.trim()) record.lastIssueId = input.lastIssueId.trim();

  const dir = linearBindingsDir(stateDir);
  await mkdir(dir, { recursive: true });
  const file = pathFor(stateDir, sessionKey);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(tmp, file);
  return record;
}

export async function deleteLinearBinding(
  stateDir: string,
  sessionKey: string,
): Promise<boolean> {
  try {
    await unlink(pathFor(stateDir, sessionKey));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Patch lastIssueId (or other fields) on an existing binding. */
export async function updateLinearBinding(
  stateDir: string,
  sessionKey: string,
  patch: Partial<
    Pick<
      LinearProjectBinding,
      | "projectName"
      | "projectUrl"
      | "teamId"
      | "teamKey"
      | "lastIssueId"
      | "boundBy"
    >
  >,
): Promise<LinearProjectBinding | undefined> {
  const existing = await loadLinearBinding(stateDir, sessionKey);
  if (!existing) return undefined;
  return saveLinearBinding(stateDir, {
    sessionKey: existing.sessionKey,
    repoKey: existing.repoKey,
    projectId: existing.projectId,
    projectName: patch.projectName ?? existing.projectName,
    projectUrl: patch.projectUrl ?? existing.projectUrl,
    teamId: patch.teamId ?? existing.teamId,
    teamKey: patch.teamKey ?? existing.teamKey,
    lastIssueId:
      patch.lastIssueId !== undefined
        ? patch.lastIssueId
        : existing.lastIssueId,
    boundBy: patch.boundBy ?? existing.boundBy,
  });
}

export async function listLinearBindings(
  stateDir: string,
): Promise<LinearProjectBinding[]> {
  const dir = linearBindingsDir(stateDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LinearProjectBinding[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isBinding(parsed)) out.push(parsed);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

/** One-line summary for /status and /linear. */
export function formatLinearBindingLine(
  binding: LinearProjectBinding | undefined,
): string {
  if (!binding) return "Linear project: _(not bound)_";
  const label =
    binding.projectName?.trim() ||
    binding.projectId;
  const url = binding.projectUrl?.trim();
  const issue = binding.lastIssueId?.trim();
  let line = `Linear project: **${label}** (\`${binding.projectId}\`)`;
  if (url) line += `\n  ${url}`;
  if (issue) line += `\n  Last issue: \`${issue}\``;
  return line;
}

/** Short block injected into agent prompts when a project is bound. */
export function formatLinearBindingContext(
  binding: LinearProjectBinding | undefined,
): string {
  if (!binding) {
    return (
      "[Linear] This topic is **not** bound to a Linear project. " +
      "Use linear_get_binding / linear_bind_project, or ask the operator " +
      "to run `/linear project <id|url>`."
    );
  }
  const parts = [
    `[Linear] This topic is bound to project "${binding.projectName ?? binding.projectId}" (id: ${binding.projectId}).`,
    "Work through open issues in that project. Prefer Linear MCP tools for list/update/comment.",
    "Confirm with the operator before bulk creates.",
  ];
  if (binding.projectUrl) parts.push(`Project URL: ${binding.projectUrl}`);
  if (binding.teamId || binding.teamKey) {
    parts.push(
      `Team: ${binding.teamKey ?? ""}${binding.teamId ? ` (${binding.teamId})` : ""}`.trim(),
    );
  }
  if (binding.lastIssueId) {
    parts.push(`Last focused issue: ${binding.lastIssueId}`);
  }
  return parts.join("\n");
}

/**
 * Compact sticky prefix for free-text turns (when bound).
 * Full recipes use formatLinearBindingContext instead.
 */
export function formatLinearStickyPrefix(
  binding: LinearProjectBinding,
): string {
  const name = binding.projectName?.trim() || binding.projectId;
  const bits = [
    `[Linear] Bound project "${name}" (id: ${binding.projectId}).`,
    "Scope work to this project's issues; use Linear MCP + linear_get_binding.",
  ];
  if (binding.lastIssueId?.trim()) {
    bits.push(`Last issue: ${binding.lastIssueId.trim()}.`);
  }
  return bits.join(" ");
}

/**
 * Prepend sticky Linear context when a project is bound.
 * Skips if the text already contains a `[Linear]` tag (command/skill prompts).
 */
export function withLinearStickyContext(
  agentText: string,
  binding: LinearProjectBinding | undefined,
): string {
  if (!binding) return agentText;
  if (agentText.includes("[Linear]")) return agentText;
  const prefix = formatLinearStickyPrefix(binding);
  const body = agentText.trimEnd();
  if (!body.trim()) return prefix;
  return `${prefix}\n\n${body}`;
}

/** Short label for /sessions list lines. */
export function formatLinearSessionListLabel(
  binding: LinearProjectBinding | undefined,
): string | undefined {
  if (!binding) return undefined;
  const name = binding.projectName?.trim() || binding.projectId;
  const issue = binding.lastIssueId?.trim();
  return issue ? `Linear: ${name} · ${issue}` : `Linear: ${name}`;
}

/** Telegram forum topic name max length. */
export const TELEGRAM_TOPIC_NAME_MAX = 128;

/**
 * Topic title when bound: base session name + project label (truncated).
 * Base is typically `topicName(repo, name)` e.g. `⏸ demo/auth`.
 */
export function formatLinearTopicTitle(
  baseTopicName: string,
  binding: LinearProjectBinding,
): string {
  const label = binding.projectName?.trim() || binding.projectId;
  const suffix = ` · ${label}`;
  const maxBase = TELEGRAM_TOPIC_NAME_MAX - suffix.length;
  if (maxBase < 8) {
    return (baseTopicName + suffix).slice(0, TELEGRAM_TOPIC_NAME_MAX);
  }
  const base =
    baseTopicName.length > maxBase
      ? `${baseTopicName.slice(0, Math.max(0, maxBase - 1))}…`
      : baseTopicName;
  return `${base}${suffix}`;
}

/** Env vars injected into MCP children when a project is bound (not secrets). */
export function linearBindingEnvVars(
  binding: LinearProjectBinding | undefined,
): Array<{ name: string; value: string }> {
  if (!binding) return [];
  const out: Array<{ name: string; value: string }> = [
    { name: "ACPBOT_LINEAR_PROJECT_ID", value: binding.projectId },
  ];
  if (binding.projectName?.trim()) {
    out.push({
      name: "ACPBOT_LINEAR_PROJECT_NAME",
      value: binding.projectName.trim(),
    });
  }
  if (binding.projectUrl?.trim()) {
    out.push({
      name: "ACPBOT_LINEAR_PROJECT_URL",
      value: binding.projectUrl.trim(),
    });
  }
  if (binding.lastIssueId?.trim()) {
    out.push({
      name: "ACPBOT_LINEAR_LAST_ISSUE",
      value: binding.lastIssueId.trim(),
    });
  }
  return out;
}
