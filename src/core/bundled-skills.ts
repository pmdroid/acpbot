/**
 * tacp ships operator skills under `<package>/skills/{telegram,schedules}/`.
 *
 * - Always listed for `/skills` via skillRoots (bundled root).
 * - On worker start, installed into global agent skill dirs so Grok/Claude/etc.
 *   see them in every workspace.
 */
import { cp, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";

/** Absolute path to package `skills/` (next to src/). */
export function bundledSkillsRoot(
  fromDir: string = import.meta.dir,
): string {
  // src/core → ../../skills
  return join(fromDir, "..", "..", "skills");
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
  installed: Array<{ target: string; mode: "symlink" | "copy" | "skip" }>;
  errors: string[];
};

/**
 * Symlink (or copy) each bundled skill into global agent skill roots.
 * Idempotent: replaces existing same-name entries that are ours or broken.
 */
export async function installBundledSkills(options?: {
  sourceRoot?: string;
  globalParents?: string[];
  log?: Logger;
  /** When true, only report what would be done. */
  dryRun?: boolean;
}): Promise<InstallBundledSkillsResult> {
  const log = options?.log ?? silentLogger();
  const source = options?.sourceRoot ?? bundledSkillsRoot();
  const parents = options?.globalParents ?? defaultGlobalSkillParents();
  const result: InstallBundledSkillsResult = {
    source,
    installed: [],
    errors: [],
  };

  let skillIds: string[] = [];
  try {
    const { readdir } = await import("node:fs/promises");
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
        await installOneSkillLink(srcSkill, dest);
        result.installed.push({ target: dest, mode: "symlink" });
        log.info("bundled skill installed", { id, dest, mode: "symlink" });
      } catch (symlinkErr) {
        try {
          await rm(dest, { recursive: true, force: true });
          await cp(srcSkill, dest, { recursive: true });
          result.installed.push({ target: dest, mode: "copy" });
          log.info("bundled skill installed", { id, dest, mode: "copy" });
        } catch (copyErr) {
          const msg = `install ${id} → ${dest}: ${
            copyErr instanceof Error ? copyErr.message : String(copyErr)
          } (symlink: ${
            symlinkErr instanceof Error ? symlinkErr.message : String(symlinkErr)
          })`;
          result.errors.push(msg);
          log.warn("bundled skill install failed", { id, dest, error: msg });
        }
      }
    }
  }

  return result;
}

async function installOneSkillLink(
  srcSkill: string,
  dest: string,
): Promise<void> {
  // If already a correct symlink, keep it.
  try {
    const st = await lstat(dest);
    if (st.isSymbolicLink()) {
      const cur = await readlink(dest);
      // Absolute or relative that resolves — compare string loosely
      if (cur === srcSkill || join(dirname(dest), cur) === srcSkill) {
        return;
      }
    }
    await rm(dest, { recursive: true, force: true });
  } catch {
    /* dest missing */
  }
  await symlink(srcSkill, dest, "dir");
}
