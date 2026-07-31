/**
 * Discover agent skills (SKILL.md trees) under configured roots + session cwd.
 * Pure filesystem scan — no ambient home path; callers supply roots.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  encodeSkillCallback,
  keyboardFromButtons,
  type InlineKeyboard,
} from "./callbacks";

export type SkillInfo = {
  /** Directory name / skill id */
  id: string;
  name: string;
  description: string;
  path: string;
  /** Which root it was found under */
  root: string;
};

const SKILL_FILE = "SKILL.md";

/** Relative subdirs under a workspace cwd that often hold skills. */
export const WORKSPACE_SKILL_SUBDIRS = [
  ".agents/skills",
  ".grok/skills",
  ".claude/skills",
  "skills",
] as const;

export function workspaceSkillRoots(cwd: string): string[] {
  return WORKSPACE_SKILL_SUBDIRS.map((sub) => join(cwd, sub));
}

/**
 * Parse name + description from SKILL.md (YAML frontmatter or first heading).
 */
export function parseSkillMarkdown(
  text: string,
  fallbackId: string,
): { name: string; description: string } {
  let name = fallbackId;
  let description = "";

  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const body = fm[1] ?? "";
    const nameM = body.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    const descM = body.match(/^description:\s*["']?([\s\S]*?)["']?\s*$/m);
    // description may be multi-line YAML; prefer single-line
    const descLine = body.match(/^description:\s*(.+)$/m);
    if (nameM?.[1]) name = nameM[1].trim().replace(/^["']|["']$/g, "");
    if (descLine?.[1]) {
      description = descLine[1].trim().replace(/^["']|["']$/g, "");
      // folded YAML ">" / "|" — take rest of block roughly
      if (description === ">" || description === "|") {
        const after = body.split(/^description:\s*[>|]\s*$/m)[1] ?? "";
        description = after
          .split(/\n(?=\w)/)[0]
          ?.replace(/^\s+/gm, " ")
          .trim() ?? "";
      }
    } else if (descM?.[1]) {
      description = descM[1].trim();
    }
  }

  if (!description) {
    const heading = text.match(/^#\s+(.+)$/m);
    if (heading?.[1] && !fm) name = heading[1].trim();
    // first non-empty non-heading paragraph after optional frontmatter
    const withoutFm = fm ? text.slice(fm[0].length) : text;
    const para = withoutFm
      .split(/\n\n+/)
      .map((p) => p.replace(/^#+\s+.*$/m, "").trim())
      .find((p) => p.length > 0 && !p.startsWith("---"));
    if (para) description = para.replace(/\s+/g, " ").slice(0, 200);
  }

  if (!description) description = "(no description)";
  return { name, description: description.slice(0, 240) };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readSkillDir(
  skillDir: string,
  root: string,
): Promise<SkillInfo | undefined> {
  const skillPath = join(skillDir, SKILL_FILE);
  try {
    const text = await readFile(skillPath, "utf8");
    const id = basename(skillDir);
    const { name, description } = parseSkillMarkdown(text, id);
    return { id, name, description, path: skillPath, root };
  } catch {
    return undefined;
  }
}

/**
 * List skills under each root. A root is either:
 * - a directory containing skill subdirs (each with SKILL.md), or
 * - a single skill directory that itself contains SKILL.md.
 */
export async function listSkills(roots: string[]): Promise<SkillInfo[]> {
  const seen = new Set<string>();
  const out: SkillInfo[] = [];

  for (const root of roots) {
    if (!(await isDir(root))) continue;

    // root is a skill itself
    const direct = await readSkillDir(root, root);
    if (direct) {
      if (!seen.has(direct.id)) {
        seen.add(direct.id);
        out.push(direct);
      }
      continue;
    }

    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (ent.startsWith(".")) continue;
      const skillDir = join(root, ent);
      if (!(await isDir(skillDir))) continue;
      const info = await readSkillDir(skillDir, root);
      if (!info || seen.has(info.id)) continue;
      seen.add(info.id);
      out.push(info);
    }
  }

  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** Skills per Telegram keyboard page (plus nav + cancel rows). */
export const SKILL_PAGE_SIZE = 8;

/** Callback skillIndex sentinels (non-negative = skill absolute index). */
export const SKILL_CB = {
  cancel: -1,
  prev: -2,
  next: -3,
  /** Page label button — no-op, answers with page info. */
  pageInfo: -4,
} as const;

export function skillPageCount(
  total: number,
  pageSize: number = SKILL_PAGE_SIZE,
): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

export function clampSkillPage(
  page: number,
  total: number,
  pageSize: number = SKILL_PAGE_SIZE,
): number {
  const pages = skillPageCount(total, pageSize);
  if (page < 0) return 0;
  if (page >= pages) return pages - 1;
  return page;
}

/** Format a compact Telegram-friendly skill list (optionally one page). */
export function formatSkillsList(
  skills: SkillInfo[],
  opts?: {
    title?: string;
    withButtons?: boolean;
    /** When set, only list this page (for paginated pickers). */
    page?: number;
    pageSize?: number;
  },
): string {
  const title = opts?.title ?? "Available skills";
  const pageSize = opts?.pageSize ?? SKILL_PAGE_SIZE;
  if (skills.length === 0) {
    return (
      `${title}\n\n` +
      "_No SKILL.md trees found under configured roots or this session cwd._\n" +
      "Grok also loads user skills from its own config; ask the agent in chat."
    );
  }

  const page =
    opts?.page !== undefined
      ? clampSkillPage(opts.page, skills.length, pageSize)
      : 0;
  const pages = skillPageCount(skills.length, pageSize);
  const start =
    opts?.page !== undefined ? page * pageSize : 0;
  const end =
    opts?.page !== undefined ? start + pageSize : skills.length;
  const slice = skills.slice(start, end);

  const lines = [
    opts?.page !== undefined
      ? `${title} (${skills.length}) · page ${page + 1}/${pages}`
      : `${title} (${skills.length})`,
    "",
    ...slice.map(
      (s) =>
        `• **${s.id}** — ${s.description.slice(0, 100)}${s.description.length > 100 ? "…" : ""}`,
    ),
  ];
  if (opts?.page === undefined && skills.length > pageSize) {
    lines.push("", `_Showing all ${skills.length} — use buttons in-topic for paging._`);
  }
  if (opts?.withButtons) {
    lines.push(
      "",
      "Tap a skill, then **send your prompt text** in this topic.",
    );
  } else {
    lines.push(
      "",
      "In a session topic use /skills for buttons, or type a prompt that names the skill.",
    );
  }
  return lines.join("\n");
}

/**
 * Build agent-facing prompt after skill pick + user text.
 * Keeps skill id/name explicit so Grok can load the right skill.
 */
export function composeSkillAgentPrompt(input: {
  skillId: string;
  skillName: string;
  skillPath?: string;
  userText: string;
}): string {
  const lines = [
    `Use the skill \`${input.skillId}\`${input.skillName !== input.skillId ? ` (${input.skillName})` : ""}.`,
  ];
  if (input.skillPath) {
    lines.push(`Skill path: ${input.skillPath}`);
  }
  lines.push("", "User request:", input.userText.trim());
  return lines.join("\n");
}

export type PendingSkillPick = {
  token: string;
  sessionKey: string;
  skills: SkillInfo[];
  page: number;
  /** Message showing the picker (edited on page change). */
  messageId?: number;
  chatId?: number;
  title?: string;
};

export type PendingSkillText = {
  sessionKey: string;
  skill: SkillInfo;
  /** Message that asked for text (for optional edit). */
  promptMessageId?: number;
};

/**
 * Build root list for a session: global config roots + workspace skill dirs.
 */
export function skillRootsForSession(
  cwd: string | undefined,
  globalRoots: string[] | undefined,
): string[] {
  const roots: string[] = [];
  if (globalRoots) roots.push(...globalRoots);
  if (cwd) roots.push(...workspaceSkillRoots(cwd));
  // de-dupe
  return [...new Set(roots)];
}

/**
 * Inline keyboard: one page of skill labels + Prev/Next + Cancel.
 * Skill callbacks use absolute indices into the full `skills` array.
 */
export function buildSkillsKeyboard(
  token: string,
  skills: SkillInfo[],
  page = 0,
  pageSize: number = SKILL_PAGE_SIZE,
): InlineKeyboard {
  const pages = skillPageCount(skills.length, pageSize);
  const p = clampSkillPage(page, skills.length, pageSize);
  const start = p * pageSize;
  const slice = skills.slice(start, start + pageSize);

  const skillButtons = slice.map((s, i) => ({
    text: truncateLabel(s.id, 28),
    callback_data: encodeSkillCallback(token, start + i),
  }));
  const rows = keyboardFromButtons(skillButtons).inline_keyboard;

  if (pages > 1) {
    const nav: { text: string; callback_data: string }[] = [];
    if (p > 0) {
      nav.push({
        text: "◀ Prev",
        callback_data: encodeSkillCallback(token, SKILL_CB.prev),
      });
    }
    nav.push({
      text: `${p + 1}/${pages}`,
      callback_data: encodeSkillCallback(token, SKILL_CB.pageInfo),
    });
    if (p < pages - 1) {
      nav.push({
        text: "Next ▶",
        callback_data: encodeSkillCallback(token, SKILL_CB.next),
      });
    }
    rows.push(nav);
  }

  rows.push([
    {
      text: "✕ Cancel",
      callback_data: encodeSkillCallback(token, SKILL_CB.cancel),
    },
  ]);
  return { inline_keyboard: rows };
}

function truncateLabel(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
