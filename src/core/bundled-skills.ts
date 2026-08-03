/**
 * acpbot ships operator skills under package `skills/{telegram,schedules}/`
 * and embeds the same content in the binary for release installs.
 *
 * - Always available for Telegram `/skills` via skillRoots (ensured root).
 * - Install into global agent dirs only via explicit `acpbot skills install`
 *   (never on worker boot).
 */
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import { BUNDLED_SKILLS } from "./bundled-skills-data";

/** Avoid importing config.ts (would cycle with skillRoots). */
function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "acpbot");
  const home =
    env.HOME?.trim() || env.USERPROFILE?.trim() || homedir() || "";
  return join(home, ".local", "share", "acpbot");
}

/** Package skills/ next to src/ when running from a git checkout. */
export function packageSkillsRoot(
  fromDir: string = import.meta.dir,
): string {
  // src/core → ../../skills
  return join(fromDir, "..", "..", "skills");
}

/** Materialised embedded skills for binary installs. */
export function defaultBundledSkillsDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(dataDir(env), "bundled-skills");
}

function skillMarkerPath(root: string, id: string): string {
  return join(root, id, "SKILL.md");
}

function rootLooksLikeSkills(root: string): boolean {
  try {
    return existsSync(skillMarkerPath(root, "telegram"));
  } catch {
    return false;
  }
}

/**
 * Prefer package `skills/` (dev checkout). Otherwise materialise embedded
 * skills under `~/.local/share/acpbot/bundled-skills/`.
 */
export function ensureBundledSkillsRoot(
  env: NodeJS.ProcessEnv = process.env,
  fromDir: string = import.meta.dir,
): string {
  const pkg = packageSkillsRoot(fromDir);
  if (rootLooksLikeSkills(pkg)) return pkg;

  const dest = defaultBundledSkillsDir(env);
  materializeEmbeddedSkillsSync(dest);
  return dest;
}

/** @deprecated use ensureBundledSkillsRoot — kept for tests that pass a fromDir */
export function bundledSkillsRoot(
  fromDir: string = import.meta.dir,
): string {
  return ensureBundledSkillsRoot(process.env, fromDir);
}

/** Write embedded skill files to dest if missing or content differs. */
export function materializeEmbeddedSkillsSync(destRoot: string): void {
  mkdirSync(destRoot, { recursive: true, mode: 0o700 });
  for (const [id, files] of Object.entries(BUNDLED_SKILLS)) {
    const skillDir = join(destRoot, id);
    mkdirSync(skillDir, { recursive: true, mode: 0o700 });
    for (const [rel, body] of Object.entries(files)) {
      const target = join(skillDir, rel);
      try {
        if (existsSync(target)) {
          const cur = readFileSync(target, "utf8");
          if (cur === body) continue;
        }
      } catch {
        /* rewrite */
      }
      writeFileSync(target, body, { encoding: "utf8", mode: 0o600 });
    }
  }
}

export async function materializeEmbeddedSkills(
  destRoot: string,
): Promise<void> {
  await mkdir(destRoot, { recursive: true, mode: 0o700 });
  for (const [id, files] of Object.entries(BUNDLED_SKILLS)) {
    const skillDir = join(destRoot, id);
    await mkdir(skillDir, { recursive: true, mode: 0o700 });
    for (const [rel, body] of Object.entries(files)) {
      const target = join(skillDir, rel);
      try {
        const cur = await readFile(target, "utf8");
        if (cur === body) continue;
      } catch {
        /* write */
      }
      await writeFile(target, body, { encoding: "utf8", mode: 0o600 });
    }
  }
}

export function listBundledSkillIds(sourceRoot: string): string[] {
  try {
    return readdirSync(sourceRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return Object.keys(BUNDLED_SKILLS).sort();
  }
}

/** Global skill parent dirs agents commonly scan. */
export function defaultGlobalSkillParents(
  home: string = process.env.HOME ?? process.env.USERPROFILE ?? homedir(),
): string[] {
  if (!home) return [];
  return [
    join(home, ".agents", "skills"),
    join(home, ".grok", "skills"),
    join(home, ".claude", "skills"),
  ];
}

export type InstallBundledSkillsResult = {
  source: string;
  installed: Array<{
    target: string;
    mode: "symlink" | "copy" | "skip" | "conflict";
  }>;
  errors: string[];
};

/**
 * Symlink (or copy) each bundled skill into global agent skill roots.
 * Idempotent for our links. Never deletes a real directory or foreign tree.
 */
export async function installBundledSkills(options?: {
  sourceRoot?: string;
  globalParents?: string[];
  log?: Logger;
  /** When true, only report what would be done. */
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallBundledSkillsResult> {
  const log = options?.log ?? silentLogger();
  const env = options?.env ?? process.env;
  const source =
    options?.sourceRoot ?? ensureBundledSkillsRoot(env);
  const parents = options?.globalParents ?? defaultGlobalSkillParents();
  const result: InstallBundledSkillsResult = {
    source,
    installed: [],
    errors: [],
  };

  let skillIds: string[] = [];
  try {
    const names = await readdir(source, { withFileTypes: true });
    skillIds = names
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => id && !id.startsWith("."));
  } catch (err) {
    result.errors.push(
      `bundled skills root unreadable: ${source}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return result;
  }

  if (skillIds.length === 0) {
    log.warn("no bundled skills found", { source });
    return result;
  }

  for (const parent of parents) {
    if (options?.dryRun) {
      for (const id of skillIds) {
        result.installed.push({
          target: join(parent, id),
          mode: "skip",
        });
      }
      continue;
    }
    try {
      await mkdir(parent, { recursive: true });
    } catch (err) {
      result.errors.push(
        `mkdir ${parent}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    for (const id of skillIds) {
      const srcSkill = join(source, id);
      const dest = join(parent, id);
      try {
        const mode = await installOneSkillLink(srcSkill, dest);
        result.installed.push({ target: dest, mode });
        if (mode === "conflict") {
          const msg = `skipped ${dest}: exists and is not an acpbot skill symlink (will not overwrite)`;
          result.errors.push(msg);
          log.warn("bundled skill conflict", { id, dest });
        } else if (mode !== "skip") {
          log.info("bundled skill installed", { id, dest, mode });
        }
      } catch (symlinkErr) {
        // Symlink unsupported (rare) — copy only if dest is free.
        try {
          if (await pathExists(dest)) {
            const msg = `skipped ${dest}: cannot symlink and path already exists`;
            result.errors.push(msg);
            result.installed.push({ target: dest, mode: "conflict" });
            log.warn("bundled skill conflict", { id, dest });
            continue;
          }
          await cp(srcSkill, dest, { recursive: true });
          result.installed.push({ target: dest, mode: "copy" });
          log.info("bundled skill installed", { id, dest, mode: "copy" });
        } catch (copyErr) {
          const msg = `install ${id} → ${dest}: ${
            copyErr instanceof Error ? copyErr.message : String(copyErr)
          } (symlink: ${
            symlinkErr instanceof Error
              ? symlinkErr.message
              : String(symlinkErr)
          })`;
          result.errors.push(msg);
          log.warn("bundled skill install failed", { id, dest, error: msg });
        }
      }
    }
  }

  return result;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

function linkPointsTo(cur: string, dest: string, srcSkill: string): boolean {
  if (cur === srcSkill) return true;
  try {
    return join(dirname(dest), cur) === srcSkill;
  } catch {
    return false;
  }
}

/**
 * Install or refresh a single skill link.
 * - Correct symlink → skip
 * - Wrong symlink → replace link only (never recursive)
 * - Real file/dir → conflict (no delete)
 */
async function installOneSkillLink(
  srcSkill: string,
  dest: string,
): Promise<"symlink" | "skip" | "conflict"> {
  try {
    const st = await lstat(dest);
    if (st.isSymbolicLink()) {
      const cur = await readlink(dest);
      if (linkPointsTo(cur, dest, srcSkill)) {
        return "skip";
      }
      // Only remove the symlink itself — never a directory tree.
      await rm(dest);
    } else {
      return "conflict";
    }
  } catch {
    /* dest missing */
  }
  await symlink(srcSkill, dest, "dir");
  return "symlink";
}
