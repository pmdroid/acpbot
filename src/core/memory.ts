/**
 * Repo-local durable memory (OpenClaw-inspired).
 *
 * Layout under **repo root** (from [repos], never host state_dir / child worktree):
 *   MEMORY.md                 curated long-term
 *   USER.md                   operator preferences / profile
 *   memory/YYYY-MM-DD.md      daily / episodic notes
 *   memory/sessions/<slug>.md optional per-session working notes
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type MemorySection = "daily" | "memory" | "user" | "session";

export type MemoryWriteMode = "append" | "replace";

/** Safe filesystem segment from sessionKey. */
export function memoryFileSlug(sessionKey: string): string {
  return (
    sessionKey
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "session"
  );
}

export function todayUtcDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Relative path from repo root for a memory section. */
export function memoryRelPath(
  section: MemorySection,
  opts?: { sessionKey?: string; date?: string },
): string {
  switch (section) {
    case "memory":
      return "MEMORY.md";
    case "user":
      return "USER.md";
    case "daily": {
      const day = opts?.date?.trim() || todayUtcDate();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new Error(`invalid daily date "${day}" — use YYYY-MM-DD`);
      }
      return `memory/${day}.md`;
    }
    case "session": {
      const sk = opts?.sessionKey?.trim();
      if (!sk) throw new Error("sessionKey required for session memory");
      return `memory/sessions/${memoryFileSlug(sk)}.md`;
    }
    default:
      throw new Error(`unknown memory section: ${section}`);
  }
}

export function memoryAbsPath(
  repoRoot: string,
  section: MemorySection,
  opts?: { sessionKey?: string; date?: string },
): string {
  return join(resolve(repoRoot), memoryRelPath(section, opts));
}

export async function memoryRead(input: {
  repoRoot: string;
  section: MemorySection;
  sessionKey?: string;
  date?: string;
}): Promise<{
  path: string;
  relPath: string;
  exists: boolean;
  content: string;
}> {
  const relPath = memoryRelPath(input.section, {
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.date ? { date: input.date } : {}),
  });
  const path = join(resolve(input.repoRoot), relPath);
  try {
    await access(path, constants.F_OK);
    const content = await readFile(path, "utf8");
    return { path, relPath, exists: true, content };
  } catch {
    return { path, relPath, exists: false, content: "" };
  }
}

export async function memoryWrite(input: {
  repoRoot: string;
  section: MemorySection;
  content: string;
  mode?: MemoryWriteMode;
  sessionKey?: string;
  date?: string;
  /** Optional heading prepended when appending (e.g. timestamp). */
  heading?: string;
}): Promise<{
  path: string;
  relPath: string;
  bytes: number;
  mode: MemoryWriteMode;
}> {
  const body = input.content.trim();
  if (!body) throw new Error("content is required");

  const mode: MemoryWriteMode = input.mode === "replace" ? "replace" : "append";
  const relPath = memoryRelPath(input.section, {
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.date ? { date: input.date } : {}),
  });
  const path = join(resolve(input.repoRoot), relPath);
  await mkdir(dirname(path), { recursive: true });

  let next: string;
  if (mode === "replace") {
    next = `${body}\n`;
  } else {
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch {
      /* new file */
    }
    const stamp = input.heading?.trim() || `## ${new Date().toISOString()}`;
    const block = `${stamp}\n\n${body}\n`;
    next = existing.trim()
      ? `${existing.replace(/\s+$/, "")}\n\n${block}`
      : `${block}`;
  }

  await writeFile(path, next, "utf8");
  return {
    path,
    relPath,
    bytes: Buffer.byteLength(next, "utf8"),
    mode,
  };
}

/** List which standard memory files exist under the repo. */
export async function memoryStatus(input: {
  repoRoot: string;
  sessionKey?: string;
}): Promise<
  Array<{ section: MemorySection; relPath: string; exists: boolean }>
> {
  const sections: Array<{
    section: MemorySection;
    opts?: { sessionKey?: string; date?: string };
  }> = [
    { section: "memory" },
    { section: "user" },
    { section: "daily", opts: { date: todayUtcDate() } },
  ];
  if (input.sessionKey?.trim()) {
    sections.push({
      section: "session",
      opts: { sessionKey: input.sessionKey },
    });
  }
  const out: Array<{
    section: MemorySection;
    relPath: string;
    exists: boolean;
  }> = [];
  for (const s of sections) {
    const r = await memoryRead({
      repoRoot: input.repoRoot,
      section: s.section,
      ...(s.opts?.sessionKey ? { sessionKey: s.opts.sessionKey } : {}),
      ...(s.opts?.date ? { date: s.opts.date } : {}),
    });
    out.push({
      section: s.section,
      relPath: r.relPath,
      exists: r.exists,
    });
  }
  return out;
}
