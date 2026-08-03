/**
 * Read/write the `[repos]` table in config.toml without rewriting the whole file.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeConfigToml } from "../config-setup";

export function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

/** Short key for /new picker: letters, digits, `_` `-` `.` */
export function isValidRepoKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(key.trim());
}

export function renderReposTomlSection(repos: Record<string, string>): string {
  const keys = Object.keys(repos).sort((a, b) => a.localeCompare(b));
  if (keys.length === 0) {
    return `# [repos]\n# demo = "/absolute/path/to/repo"\n`;
  }
  const lines = ["[repos]"];
  for (const k of keys) {
    lines.push(`${k} = ${tomlString(repos[k]!)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Locate the `[repos]` block (or a commented `# [repos]` stub).
 * Range is [start, end) line indices into the split body.
 */
export function findReposSectionRange(
  lines: string[],
): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === "[repos]") {
      start = i;
      break;
    }
    if (/^#\s*\[repos\]\s*$/.test(t)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    // Next top-level table (not a comment)
    if (/^\[[^\]]+\]/.test(t)) {
      end = i;
      break;
    }
  }
  // Trim trailing blank lines from the block (keep one blank when re-joining)
  while (end > start + 1 && lines[end - 1]!.trim() === "") {
    end -= 1;
  }
  return { start, end };
}

/**
 * Replace or insert the `[repos]` section. Preserves all other content.
 */
export function replaceReposSection(
  tomlBody: string,
  repos: Record<string, string>,
): string {
  const normalized = tomlBody.replace(/\r\n/g, "\n");
  const endsWithNl = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  // drop trailing empty from split if body ended with newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const section = renderReposTomlSection(repos).replace(/\n$/, "");
  const sectionLines = section.split("\n");
  const range = findReposSectionRange(lines);

  let out: string[];
  if (range) {
    out = [
      ...lines.slice(0, range.start),
      ...sectionLines,
      ...lines.slice(range.end),
    ];
  } else {
    // Insert before [features] if present, else before first [section], else append
    let insertAt = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (t === "[features]" || t.startsWith("[features]")) {
        insertAt = i;
        break;
      }
    }
    if (insertAt === lines.length) {
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i]!.trim();
        if (/^\[[^\]]+\]/.test(t) && t !== "[repos]") {
          insertAt = i;
          break;
        }
      }
    }
    out = [
      ...lines.slice(0, insertAt),
      ...sectionLines,
      ...(insertAt < lines.length && lines[insertAt]!.trim() !== ""
        ? [""]
        : []),
      ...lines.slice(insertAt),
    ];
  }

  // Ensure a blank line after the repos block when a following section exists
  const joined = out.join("\n");
  // Collapse 3+ blank lines to 2
  const cleaned = joined.replace(/\n{3,}/g, "\n\n");
  return endsWithNl || cleaned.length > 0 ? cleaned.replace(/\n?$/, "\n") : cleaned;
}

export function readConfigTomlBody(configPath: string): string {
  if (!existsSync(configPath)) {
    throw new Error(`config not found: ${configPath}`);
  }
  return readFileSync(configPath, "utf8");
}

export function writeReposToConfig(
  configPath: string,
  repos: Record<string, string>,
): void {
  const body = readConfigTomlBody(configPath);
  const next = replaceReposSection(body, repos);
  writeConfigToml(configPath, next);
}

/** Parse [repos] from a TOML body via Bun.TOML (values as strings). */
export function parseReposFromToml(body: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(body);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const repos = (parsed as Record<string, unknown>).repos;
  if (!repos || typeof repos !== "object" || Array.isArray(repos)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(repos as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}
