/**
 * Freeze a git change bundle for multi-reviewer panels.
 * Modes: local (dirty), branch (merge-base..head). PR later via gh.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type ReviewBundleMode = "local" | "branch";

export type ReviewBundle = {
  id: string;
  mode: ReviewBundleMode;
  cwd: string;
  /** Human label for digests */
  label: string;
  baseRef?: string;
  headRef?: string;
  diffText: string;
  files: string[];
  byteLength: number;
  empty: boolean;
  dir: string;
  diffPath: string;
  metaPath: string;
};

export type BuildBundleOptions = {
  cwd: string;
  mode: ReviewBundleMode;
  /** Branch mode base (default origin/main → origin/master → main). */
  base?: string;
  /** Branch mode head (default HEAD). */
  head?: string;
  /** State dir root; writes under reviews/<id>/ */
  stateDir: string;
  /** Soft warn threshold; hard fail above maxBytes. */
  warnBytes?: number;
  maxBytes?: number;
};

const DEFAULT_WARN = 1_000_000;
const DEFAULT_MAX = 10_000_000;

function git(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
  };
}

function resolveBase(cwd: string, preferred?: string): string {
  if (preferred?.trim()) {
    const p = preferred.trim();
    const check = git(cwd, ["rev-parse", "--verify", "--quiet", p]);
    if (check.ok) return p;
    throw new Error(`base ref not found: ${p}`);
  }
  for (const cand of ["origin/main", "origin/master", "main", "master"]) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", cand]).ok) return cand;
  }
  throw new Error(
    "no base ref found (tried origin/main, origin/master, main, master)",
  );
}

function collectLocal(cwd: string): { diff: string; files: string[] } {
  const hasHead = git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
  let diff = "";
  if (hasHead) {
    const d = git(cwd, ["diff", "HEAD"]);
    // git diff exits 0 even with changes
    diff = d.stdout;
  }

  const untracked = git(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const files = new Set<string>();
  if (hasHead) {
    const names = git(cwd, ["diff", "--name-only", "HEAD"]);
    for (const line of names.stdout.split("\n")) {
      if (line.trim()) files.add(line.trim());
    }
  }
  if (untracked.ok && untracked.stdout) {
    const parts = untracked.stdout.split("\0").filter(Boolean);
    for (const f of parts) {
      files.add(f);
      // Append as added-file diff (git diff --no-index exits 1 when different)
      const add = spawnSync(
        "git",
        ["-c", "core.quotepath=false", "diff", "--no-index", "--", "/dev/null", f],
        { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      if (add.stdout) {
        diff += (diff.endsWith("\n") || !diff ? "" : "\n") + add.stdout;
      }
    }
  }

  return { diff, files: [...files].sort() };
}

function collectBranch(
  cwd: string,
  base: string,
  head: string,
): { diff: string; files: string[]; mergeBase: string } {
  const mb = git(cwd, ["merge-base", base, head]);
  if (!mb.ok || !mb.stdout.trim()) {
    throw new Error(
      `merge-base failed for ${base}..${head}: ${mb.stderr || "unknown"}`,
    );
  }
  const mergeBase = mb.stdout.trim();
  const d = git(cwd, ["diff", `${mergeBase}..${head}`]);
  if (!d.ok && d.status !== 0 && !d.stdout) {
    throw new Error(`git diff failed: ${d.stderr || "unknown"}`);
  }
  const names = git(cwd, ["diff", "--name-only", `${mergeBase}..${head}`]);
  const files = names.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
  return { diff: d.stdout, files, mergeBase };
}

/**
 * Build and persist a frozen review bundle under stateDir/reviews/<id>/.
 */
export function buildReviewBundle(opts: BuildBundleOptions): ReviewBundle {
  const cwd = opts.cwd;
  if (!existsSync(cwd)) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    throw new Error("review requires a git work tree");
  }

  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const dir = join(opts.stateDir, "reviews", id);
  mkdirSync(dir, { recursive: true });

  const warnBytes = opts.warnBytes ?? DEFAULT_WARN;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX;

  let diffText = "";
  let files: string[] = [];
  let label = "";
  let baseRef: string | undefined;
  let headRef: string | undefined;

  if (opts.mode === "local") {
    const local = collectLocal(cwd);
    diffText = local.diff;
    files = local.files;
    label = "local (dirty tree)";
  } else {
    const base = resolveBase(cwd, opts.base);
    const head = opts.head?.trim() || "HEAD";
    if (!git(cwd, ["rev-parse", "--verify", "--quiet", head]).ok) {
      throw new Error(`head ref not found: ${head}`);
    }
    const br = collectBranch(cwd, base, head);
    diffText = br.diff;
    files = br.files;
    baseRef = br.mergeBase;
    headRef = head;
    label = `branch ${head} vs ${base} (merge-base ${br.mergeBase.slice(0, 8)})`;
  }

  const byteLength = Buffer.byteLength(diffText, "utf8");
  if (byteLength > maxBytes) {
    throw new Error(
      `review bundle too large (${byteLength} bytes > ${maxBytes}). ` +
        `Ignore large artifacts or split the change.`,
    );
  }

  const empty = !diffText.trim() && files.length === 0;
  const diffPath = join(dir, "bundle.diff");
  const metaPath = join(dir, "meta.json");
  writeFileSync(diffPath, diffText, "utf8");
  const meta = {
    id,
    mode: opts.mode,
    cwd,
    label,
    baseRef,
    headRef,
    files,
    byteLength,
    empty,
    createdAt: Date.now(),
    warn: byteLength > warnBytes,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  writeFileSync(join(dir, "files.txt"), files.join("\n") + (files.length ? "\n" : ""), "utf8");

  return {
    id,
    mode: opts.mode,
    cwd,
    label,
    ...(baseRef !== undefined ? { baseRef } : {}),
    ...(headRef !== undefined ? { headRef } : {}),
    diffText,
    files,
    byteLength,
    empty,
    dir,
    diffPath,
    metaPath,
  };
}
