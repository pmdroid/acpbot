/**
 * Multi-agent spawn: parent-linked registry + always-new git worktree + A2A auth.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { constants } from "node:fs";
import {
  addSpawnRecord,
  authorizeAgentPeer,
  childSessionKey,
  emptySpawnIndex,
  listChildren,
  resolveAgentTarget,
  validateChildSlug,
} from "../src/core/agent-spawn-registry";
import {
  createAgentWorktree,
  isGitWorkTree,
  removeAgentWorktree,
  childBranchName,
  defaultWorktreePath,
} from "../src/core/agent-worktree";
import {
  agentSpawn,
  agentList,
  agentKill,
  agentSend,
  agentWait,
  markChildResult,
} from "../src/core/agent-spawn";

async function initGitRepo(dir: string): Promise<void> {
  const run = async (args: string[]) => {
    const p = Bun.spawn(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await p.exited;
    if (code !== 0) {
      const err = await new Response(p.stderr).text();
      throw new Error(`git ${args.join(" ")} failed: ${err}`);
    }
  };
  await run(["init"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);
  await Bun.write(join(dir, "README.md"), "# test\n");
  await run(["add", "."]);
  await run(["commit", "-m", "init"]);
}

describe("spawn registry", () => {
  test("childSessionKey and parent link required", () => {
    expect(validateChildSlug("impl-auth")).toBe("impl-auth");
    expect(() => validateChildSlug("Bad Name")).toThrow(/invalid/);
    expect(childSessionKey("work/plan", "impl")).toBe("work/plan--impl");

    let idx = emptySpawnIndex();
    const rec = {
      runId: "r1",
      childSessionKey: "work/plan--impl",
      parentSessionKey: "work/plan",
      agent: "codex",
      status: "idle" as const,
      worktreePath: "/tmp/wt",
      branch: "acpbot/plan--impl",
      baseRef: "abc",
      depth: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    idx = addSpawnRecord(idx, rec);
    expect(listChildren(idx, "work/plan")).toHaveLength(1);
    expect(authorizeAgentPeer(idx, "work/plan", "work/plan--impl").ok).toBe(
      true,
    );
    expect(authorizeAgentPeer(idx, "work/plan--impl", "work/plan").ok).toBe(
      true,
    );
    // sibling mesh denied
    idx = addSpawnRecord(idx, {
      ...rec,
      runId: "r2",
      childSessionKey: "work/plan--rev",
      branch: "acpbot/plan--rev",
      worktreePath: "/tmp/wt2",
    });
    expect(
      authorizeAgentPeer(idx, "work/plan--impl", "work/plan--rev").ok,
    ).toBe(false);
    expect(resolveAgentTarget(idx, "work/plan", "impl")).toBe(
      "work/plan--impl",
    );
    expect(resolveAgentTarget(idx, "work/plan--impl", "parent")).toBe(
      "work/plan",
    );
  });
});

describe("git worktree", () => {
  test("create and remove worktree differs from parent cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpbot-wt-repo-"));
    const state = await mkdtemp(join(tmpdir(), "acpbot-wt-state-"));
    try {
      await initGitRepo(root);
      expect(await isGitWorkTree(root)).toBe(true);

      const childKey = "demo/plan--impl";
      const wtPath = defaultWorktreePath(state, "demo", childKey);
      const branch = childBranchName("demo/plan", "impl");
      const created = await createAgentWorktree({
        repoRoot: root,
        worktreePath: wtPath,
        branch,
      });
      expect(created.worktreePath).toBe(wtPath);
      expect(created.branch).toBe(branch);
      expect(wtPath).not.toBe(root);
      await access(join(wtPath, "README.md"), constants.F_OK);

      // list worktrees includes path
      const list = Bun.spawn(["git", "worktree", "list"], {
        cwd: root,
        stdout: "pipe",
      });
      const out = await new Response(list.stdout).text();
      expect(out).toContain(wtPath);

      await removeAgentWorktree({
        repoRoot: root,
        worktreePath: wtPath,
        branch,
        removeWorktree: true,
        deleteBranch: false,
      });
      // path should be gone
      await expect(access(wtPath, constants.F_OK)).rejects.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });

  test("non-git parent fails clearly", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpbot-nongit-"));
    try {
      await expect(
        createAgentWorktree({
          repoRoot: root,
          worktreePath: join(root, "wt"),
          branch: "acpbot/x",
        }),
      ).rejects.toThrow(/git work tree/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("agentSpawn orchestration", () => {
  test("spawn → list → send/wait auth → kill removes worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpbot-spawn-repo-"));
    const state = await mkdtemp(join(tmpdir(), "acpbot-spawn-state-"));
    try {
      await initGitRepo(root);
      const sessions: string[] = [];
      const prompts: Array<{ sessionKey: string; message: string }> = [];

      const rec = await agentSpawn(
        {
          stateDir: state,
          parentRepoRoot: root,
          parentSessionKey: "demo/plan",
          repoKey: "demo",
          createChildSession: async (input) => {
            expect(input.parentSessionKey).toBe("demo/plan");
            expect(input.cwd).not.toBe(root);
            sessions.push(input.sessionKey);
            return { sessionKey: input.sessionKey };
          },
          ensureAndMaybePrompt: async (input) => {
            if (input.prompt) {
              prompts.push({
                sessionKey: input.sessionKey,
                message: input.prompt,
              });
            }
          },
          deliverMessage: async (input) => {
            prompts.push({
              sessionKey: input.sessionKey,
              message: input.message,
            });
            return { summary: "child done: ok" };
          },
          isBusy: () => false,
        },
        {
          name: "impl",
          agent: "codex",
          role: "implementer",
          prompt: "implement auth",
        },
      );

      expect(rec.parentSessionKey).toBe("demo/plan");
      expect(rec.childSessionKey).toBe("demo/plan--impl");
      expect(rec.worktreePath).not.toBe(root);
      await access(join(rec.worktreePath, "README.md"), constants.F_OK);
      expect(sessions).toEqual(["demo/plan--impl"]);
      expect(prompts.some((p) => p.message.includes("implement auth"))).toBe(
        true,
      );

      const listed = await agentList(state, "demo/plan");
      expect(listed).toHaveLength(1);
      expect(listed[0]!.worktreePath).toBe(rec.worktreePath);

      // mark result + wait
      await markChildResult(state, rec.childSessionKey, "all green", "idle");
      const waited = await agentWait({
        stateDir: state,
        callerSessionKey: "demo/plan",
        childSessionKey: rec.childSessionKey,
        timeoutSec: 2,
        pollSec: 0.2,
        isBusy: () => false,
      });
      expect(waited.status).toBe("idle");
      expect(waited.summary).toContain("all green");

      // send authorized
      const sent = await agentSend(
        {
          stateDir: state,
          parentRepoRoot: root,
          parentSessionKey: "demo/plan",
          repoKey: "demo",
          callerSessionKey: "demo/plan",
          createChildSession: async () => ({ sessionKey: "" }),
          ensureAndMaybePrompt: async () => {},
          deliverMessage: async () => ({ summary: "acked" }),
        },
        { to: "impl", message: "please open PR" },
      );
      expect(sent.to).toBe("demo/plan--impl");

      // sibling denied via authorize in send would need second child — skip

      await agentKill({
        stateDir: state,
        parentRepoRoot: root,
        callerSessionKey: "demo/plan",
        childSessionKey: rec.childSessionKey,
        dispose: true,
        config: { removeWorktreeOnKill: true, deleteBranchOnKill: false },
      });

      await expect(
        access(rec.worktreePath, constants.F_OK),
      ).rejects.toBeTruthy();
      expect(await agentList(state, "demo/plan")).toHaveLength(0);

      // registry file exists
      const raw = await readFile(join(state, "agent-spawns.json"), "utf8");
      expect(raw).toContain("byChild");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });
});
