/**
 * Git worktree helpers for multi-agent spawn.
 * Every child session gets a new worktree + branch (never parent cwd).
 */
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CreateWorktreeInput = {
  /** Parent session repo root (must be a git work tree). */
  repoRoot: string;
  /** Absolute path for the new worktree directory. */
  worktreePath: string;
  /** Branch name to create (e.g. acpbot/plan--impl). */
  branch: string;
  /** Start point (default HEAD). */
  baseRef?: string;
  /** Override git binary (tests). */
  gitBin?: string;
  /** Inject runner (tests). */
  run?: (
    args: string[],
    opts: { cwd: string },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};

export type CreateWorktreeResult = {
  worktreePath: string;
  branch: string;
  baseRef: string;
};

async function defaultRun(
  args: string[],
  opts: { cwd: string },
  gitBin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([gitBin, ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** True when cwd is inside a git work tree. */
export async function isGitWorkTree(
  cwd: string,
  opts?: {
    gitBin?: string;
    run?: CreateWorktreeInput["run"];
  },
): Promise<boolean> {
  const gitBin = opts?.gitBin ?? "git";
  const run =
    opts?.run ??
    ((args, o) => defaultRun(args, o, gitBin));
  const r = await run(["rev-parse", "--is-inside-work-tree"], { cwd });
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Resolve HEAD sha (or symbolic ref name). */
export async function resolveHeadRef(
  cwd: string,
  opts?: {
    gitBin?: string;
    run?: CreateWorktreeInput["run"];
  },
): Promise<string> {
  const gitBin = opts?.gitBin ?? "git";
  const run =
    opts?.run ??
    ((args, o) => defaultRun(args, o, gitBin));
  const r = await run(["rev-parse", "HEAD"], { cwd });
  if (r.code !== 0) {
    throw new Error(
      `git rev-parse HEAD failed in ${cwd}: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r.stdout.trim();
}

/**
 * Create a new branch + worktree at worktreePath from baseRef (default HEAD).
 * Fails if path exists or branch exists.
 */
export async function createAgentWorktree(
  input: CreateWorktreeInput,
): Promise<CreateWorktreeResult> {
  const repoRoot = resolve(input.repoRoot);
  const worktreePath = resolve(input.worktreePath);
  const branch = input.branch.trim();
  if (!branch) throw new Error("branch name is required");
  if (!/^[A-Za-z0-9._/\-]+$/.test(branch) || branch.includes("..")) {
    throw new Error(`invalid branch name: ${branch}`);
  }

  const gitBin = input.gitBin ?? "git";
  const run =
    input.run ??
    ((args, o) => defaultRun(args, o, gitBin));

  const inside = await isGitWorkTree(repoRoot, { gitBin, run });
  if (!inside) {
    throw new Error(
      `multi-agent spawn requires a git work tree (not a git repo): ${repoRoot}`,
    );
  }

  const baseRef = (input.baseRef?.trim() ||
    (await resolveHeadRef(repoRoot, { gitBin, run }))).trim();

  // Fail if worktree path already exists
  try {
    await access(worktreePath, constants.F_OK);
    throw new Error(`worktree path already exists: ${worktreePath}`);
  } catch (e) {
    if (e instanceof Error && e.message.includes("already exists")) throw e;
    // ENOENT ok
  }

  await mkdir(dirname(worktreePath), { recursive: true });

  // git worktree add -b <branch> <path> <base>
  const r = await run(
    ["worktree", "add", "-b", branch, worktreePath, baseRef],
    { cwd: repoRoot },
  );
  if (r.code !== 0) {
    throw new Error(
      `git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }

  return { worktreePath, branch, baseRef };
}

export type RemoveWorktreeInput = {
  repoRoot: string;
  worktreePath: string;
  branch?: string;
  /** Remove worktree directory (default true). */
  removeWorktree?: boolean;
  /** Delete branch (default false — keep for PRs). */
  deleteBranch?: boolean;
  gitBin?: string;
  run?: CreateWorktreeInput["run"];
};

export async function removeAgentWorktree(
  input: RemoveWorktreeInput,
): Promise<void> {
  const repoRoot = resolve(input.repoRoot);
  const worktreePath = resolve(input.worktreePath);
  const gitBin = input.gitBin ?? "git";
  const run =
    input.run ??
    ((args, o) => defaultRun(args, o, gitBin));

  if (input.removeWorktree !== false) {
    const r = await run(
      ["worktree", "remove", "--force", worktreePath],
      { cwd: repoRoot },
    );
    if (r.code !== 0) {
      // Best-effort: try prune if path already gone
      await run(["worktree", "prune"], { cwd: repoRoot });
      const still = await run(["worktree", "list", "--porcelain"], {
        cwd: repoRoot,
      });
      if (still.stdout.includes(worktreePath)) {
        throw new Error(
          `git worktree remove failed: ${r.stderr.trim() || r.stdout.trim()}`,
        );
      }
    }
  }

  if (input.deleteBranch && input.branch?.trim()) {
    await run(["branch", "-D", input.branch.trim()], { cwd: repoRoot });
  }
}

/** Sanitize sessionKey for filesystem path segment. */
export function sanitizeSessionKeyForPath(sessionKey: string): string {
  return sessionKey
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "child";
}

/** Default branch name for a child. */
export function childBranchName(
  parentSessionKey: string,
  childSlug: string,
  prefix = "acpbot/",
): string {
  const leaf = parentSessionKey.includes("/")
    ? parentSessionKey.split("/").slice(1).join("--")
    : parentSessionKey;
  const safeLeaf = leaf.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48);
  const safeSlug = childSlug.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 32);
  return `${prefix}${safeLeaf}--${safeSlug}`;
}

/** Default worktree path under stateDir. */
export function defaultWorktreePath(
  stateDir: string,
  repoKey: string,
  childSessionKey: string,
): string {
  return join(
    resolve(stateDir),
    "worktrees",
    sanitizeSessionKeyForPath(repoKey),
    sanitizeSessionKeyForPath(childSessionKey),
  );
}
