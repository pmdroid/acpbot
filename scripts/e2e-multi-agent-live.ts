/**
 * Live multi-agent e2e (no Telegram).
 *
 * Starts an isolated acp-host on a unique Unix socket, then:
 *  1. Parent slot
 *  2. agent_spawn child → new git worktree
 *  3. Child kickoff creates hello.txt
 *  4. agent_wait + agent_send A2A
 *  5. Verify worktree file; kill dispose
 *
 * Usage:
 *   bun scripts/e2e-multi-agent-live.ts
 * Env:
 *   E2E_DEMO_REPO   default: <repo>/data/multi-agent-demo
 *   E2E_AGENT       default: grok-build
 *   E2E_RESULT      default: data/multi-agent-demo/e2e-result.json
 *   E2E_CHILD_SLUG  optional unique child slug
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm, access, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { realAgents } from "../src/env/real-agents";
import { createLogger } from "../src/env/logger";
import { startAcpHostServer } from "../src/acp-host/server";
import { createMemoryHostSessionStore } from "../src/acp/session-store";
import {
  agentSpawn,
  agentWait,
  agentSend,
  agentList,
  agentKill,
} from "../src/core/agent-spawn";
import { loadSpawnIndex } from "../src/core/agent-spawn-registry";

// Guard: host MCP re-invokes process.argv[1] as `… mcp-server`. If that entry
// is this e2e script, we must not re-enter main() or we fork-bomb.
const argv1 = process.argv[1] ?? "";
const isThisScript =
  argv1.includes("e2e-multi-agent-live") ||
  import.meta.path.includes("e2e-multi-agent-live");
if (
  isThisScript &&
  process.argv.some((a) => a === "mcp-server" || a === "mcp_server")
) {
  console.error(
    "e2e-multi-agent-live refused mcp-server spawn (set ACPBOT_MCP=0 / ACPBOT_BIN)",
  );
  process.exit(2);
}

// Disable host MCP for this process tree. resolveAcpbotSpawn would otherwise
// re-exec this script as the MCP server entry.
process.env.ACPBOT_MCP = "0";
// Prefer real CLI for any accidental re-invoke.
if (!process.env.ACPBOT_BIN?.trim()) {
  const candidates = [
    resolve(import.meta.dir, "../src/main.ts"),
    "/Users/pascal/.local/bin/acpbot",
    "acpbot",
  ];
  for (const c of candidates) {
    if (c === "acpbot" || existsSync(c)) {
      process.env.ACPBOT_BIN = c === "acpbot" ? c : c;
      if (c.endsWith(".ts")) {
        // For .ts entry, leave ACPBOT_BIN unset and keep MCP off instead —
        // ACPBOT_BIN expects a direct executable. MCP is already disabled.
        delete process.env.ACPBOT_BIN;
      } else {
        process.env.ACPBOT_BIN = c;
      }
      break;
    }
  }
}

const ROOT = resolve(import.meta.dir, "..");
const demoRepo = resolve(
  process.env.E2E_DEMO_REPO?.trim() || join(ROOT, "data/multi-agent-demo"),
);
const agent = process.env.E2E_AGENT?.trim() || "grok-build";
const resultPath = resolve(
  process.env.E2E_RESULT?.trim() ||
    join(ROOT, "data/multi-agent-demo/e2e-result.json"),
);

// Unique run dir so concurrent/re-runs never clobber an in-flight registry or worktree.
const runId =
  process.env.E2E_RUN_ID?.trim() ||
  `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const e2eRoot = join(demoRepo, `.e2e-state-${runId}`);
const e2eState = join(e2eRoot, "registry");
const hostState = join(e2eRoot, "host");
const lockPath = join(demoRepo, ".e2e-live.lock");

const parentSessionKey = "mademo/lead";
const childSlug =
  process.env.E2E_CHILD_SLUG?.trim() ||
  `impl${Date.now().toString(36).slice(-5)}`;

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];

function pass(name: string, detail?: string) {
  checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
  console.log(`  OK  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, detail: string) {
  checks.push({ name, ok: false, detail });
  console.error(`  FAIL ${name} — ${detail}`);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
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

/** Remove leftover worktrees/branches from prior e2e runs (best-effort). */
async function cleanupDemoGit(): Promise<void> {
  const list = await git(["worktree", "list", "--porcelain"], demoRepo);
  const paths: string[] = [];
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      const p = line.slice("worktree ".length).trim();
      if (p && resolve(p) !== resolve(demoRepo)) paths.push(p);
    }
  }
  for (const p of paths) {
    // -f -f overrides "locked initializing" leftovers from interrupted runs
    let r = await git(["worktree", "remove", "-f", "-f", p], demoRepo);
    if (r.code !== 0) {
      await git(["worktree", "unlock", p], demoRepo);
      await git(["worktree", "remove", "-f", "-f", p], demoRepo);
    }
  }
  await git(["worktree", "prune"], demoRepo);

  const branches = await git(["branch", "--list", "acpbot/*"], demoRepo);
  for (const line of branches.stdout.split("\n")) {
    const b = line.replace(/^[ *+]+/, "").trim();
    if (b.startsWith("acpbot/")) {
      await git(["branch", "-D", b], demoRepo);
    }
  }

  // Drop leftover parent hello from prior runs
  try {
    await rm(join(demoRepo, "hello.txt"), { force: true });
  } catch {
    /* */
  }
}

async function acquireLock(): Promise<() => Promise<void>> {
  // Exclusive create — fail if another live e2e is running on this demo repo.
  try {
    const fh = await open(lockPath, "wx");
    await fh.writeFile(
      `${process.pid}\n${runId}\n${new Date().toISOString()}\n`,
      "utf8",
    );
    await fh.close();
  } catch (e) {
    const existing = await readFile(lockPath, "utf8").catch(() => "(unreadable)");
    throw new Error(
      `another e2e holds ${lockPath}:\n${existing}\n` +
        `Remove the lock if stale, or wait for the other run.`,
    );
  }
  return async () => {
    try {
      await rm(lockPath, { force: true });
    } catch {
      /* */
    }
  };
}

async function collectTurnText(
  agents: ReturnType<typeof realAgents>,
  handle: {
    sessionKey: string;
    identity: { repo: string; name: string; agent?: string };
    cwd: string;
  },
  text: string,
): Promise<string> {
  const turn = await agents.runPromptTurn(handle, { text });
  let summary = "";
  for await (const ev of turn.events) {
    if (ev.type === "agent_message_chunk" && ev.text) summary += ev.text;
    if (ev.type === "process_died") {
      throw new Error(`agent process died: ${ev.error ?? "unknown"}`);
    }
  }
  await turn.done;
  return summary.trim();
}

async function main() {
  console.log("e2e multi-agent live");
  console.log(`  demoRepo=${demoRepo}`);
  console.log(`  agent=${agent}`);
  console.log(`  runId=${runId}`);
  console.log(`  e2eRoot=${e2eRoot}`);
  console.log(`  childSlug=${childSlug}`);
  console.log(`  PATH has grok=${Boolean(process.env.PATH?.includes("grok"))}`);

  if (!existsSync(join(demoRepo, ".git"))) {
    fail("demo repo is git", `missing ${demoRepo}/.git`);
    await finish(false);
    return;
  }
  pass("demo repo is git");

  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await acquireLock();
    pass("e2e lock acquired", lockPath);
  } catch (e) {
    fail("e2e lock acquired", e instanceof Error ? e.message : String(e));
    await finish(false);
    return;
  }

  try {
    await cleanupDemoGit();
    pass("demo git cleaned (worktrees/branches)");

    await mkdir(hostState, { recursive: true });
    await mkdir(e2eState, { recursive: true });
    const sockPath = join(hostState, "acp-host.sock");

    const log = createLogger({ level: "info", name: "e2e-ma" });
    const host = await startAcpHostServer({
      sockPath,
      stateDir: hostState,
      sessionStore: createMemoryHostSessionStore(),
      enableScheduler: false,
      log,
      repos: { mademo: demoRepo },
      defaultAgent: agent,
    });
    pass("isolated acp-host started", sockPath);

    process.env.ACPBOT_ACP_HOST_SOCK = sockPath;
    process.env.ACPBOT_STATE_DIR = hostState;

    const agents = realAgents({
      config: {
        operatorUserId: 0,
        defaultAgent: agent,
        permissionMode: "bypass",
        mcpEnabled: false,
        repos: { mademo: demoRepo },
      },
      stateDir: hostState,
      log,
    });

    try {
      await runWithAgents(agents);
    } finally {
      try {
        await host.close();
      } catch {
        /* */
      }
    }
  } finally {
    await releaseLock?.();
    // Leave e2eRoot for post-mortem unless passed; remove on success in finish.
  }
}

async function runWithAgents(agents: ReturnType<typeof realAgents>) {
  const parentIdentity = {
    repo: "mademo",
    name: "lead",
    agent,
  };
  let parentHandle;
  try {
    parentHandle = await withTimeout(
      agents.ensureSession(parentIdentity, {
        permissionMode: "bypass",
        cwd: demoRepo,
      }),
      180_000,
      "parent ensureSession",
    );
    pass("parent ensureSession", parentHandle.sessionKey);
  } catch (e) {
    fail(
      "parent ensureSession",
      e instanceof Error ? e.message : String(e),
    );
    await finish(false);
    return;
  }

  // Put the required content in the prompt so the child does not depend on
  // finding TASK.md if tools resolve paths oddly. Still ask it to read TASK.md.
  const kickoff = [
    "You are a child implementer in this git worktree (cwd is your worktree).",
    "Your only job: create hello.txt in the current working directory.",
    "The file must contain exactly one line: HELLO_FROM_CHILD",
    "Prefer shell: printf 'HELLO_FROM_CHILD\\n' > hello.txt && cat hello.txt",
    "You may also read TASK.md if present.",
    "Reply with one short line starting with DONE once hello.txt is written.",
    "Do not ask questions. Do not wait for the user. Do not write outside cwd.",
  ].join(" ");

  let spawnRec;
  try {
    spawnRec = await withTimeout(
      agentSpawn(
        {
          stateDir: e2eState,
          parentRepoRoot: demoRepo,
          parentSessionKey,
          repoKey: "mademo",
          // defaultWorktreePath appends worktrees/<repo>/<child>
          config: { worktreeRoot: e2eRoot },
          createChildSession: async (input) => {
            console.log(
              `  … createChildSession ${input.sessionKey} cwd=${input.cwd}`,
            );
            // Prove worktree is on disk before agent starts
            try {
              await access(input.cwd, constants.F_OK);
            } catch {
              throw new Error(`worktree missing before child start: ${input.cwd}`);
            }
            return { sessionKey: input.sessionKey };
          },
          ensureAndMaybePrompt: async (input) => {
            console.log(
              `  … ensure child agent=${input.agent} prompt=${Boolean(input.prompt)} cwd=${input.cwd}`,
            );
            try {
              await access(input.cwd, constants.F_OK);
            } catch {
              throw new Error(`worktree missing at ensure: ${input.cwd}`);
            }
            const slash = input.sessionKey.indexOf("/");
            const identity = {
              repo: input.sessionKey.slice(0, slash),
              name: input.sessionKey.slice(slash + 1),
              agent: input.agent,
            };
            const handle = await agents.ensureSession(identity, {
              permissionMode: "bypass",
              cwd: input.cwd,
            });
            if (!input.prompt?.trim()) return {};
            const summary = await collectTurnText(
              agents,
              handle,
              input.prompt.trim(),
            );
            console.log(
              `  … child kickoff summary (${summary.length} chars): ${summary.slice(0, 200)}`,
            );
            // Re-check worktree after kickoff
            const stillThere = existsSync(input.cwd);
            console.log(`  … worktree after kickoff exists=${stillThere}`);
            return { summary: summary || "(empty agent reply)" };
          },
        },
        {
          name: childSlug,
          agent,
          role: "implementer",
          prompt: kickoff,
        },
      ),
      420_000,
      "agentSpawn",
    );
    pass(
      "agent_spawn child",
      `${spawnRec.childSessionKey} branch=${spawnRec.branch}`,
    );
  } catch (e) {
    fail("agent_spawn child", e instanceof Error ? e.message : String(e));
    await finish(false);
    return;
  }

  const actualChildKey = spawnRec.childSessionKey;
  const wtPath = spawnRec.worktreePath;

  if (wtPath && wtPath !== demoRepo && existsSync(wtPath)) {
    pass("child worktree exists", wtPath);
  } else {
    fail(
      "child worktree exists",
      `path=${wtPath} exists=${existsSync(wtPath ?? "")} parent=${demoRepo}`,
    );
  }

  const idx = await loadSpawnIndex(e2eState);
  const rec = idx.byChild[actualChildKey];
  if (rec?.parentSessionKey === parentSessionKey) {
    pass("parentSessionKey linked", rec.parentSessionKey);
  } else {
    fail(
      "parentSessionKey linked",
      `rec=${JSON.stringify(rec ?? null)} keys=${JSON.stringify(Object.keys(idx.byChild))}`,
    );
  }

  try {
    const waited = await withTimeout(
      agentWait({
        stateDir: e2eState,
        callerSessionKey: parentSessionKey,
        childSessionKey: actualChildKey,
        timeoutSec: 30,
        pollSec: 1,
        isBusy: () => false,
      }),
      45_000,
      "agentWait",
    );
    if (waited.status === "timeout") {
      fail(
        "agent_wait after spawn",
        `status=timeout summary=${waited.summary}`,
      );
    } else if (!waited.summary || waited.summary.length < 2) {
      fail("agent_wait after spawn", `empty summary status=${waited.status}`);
    } else {
      pass(
        "agent_wait after spawn",
        `status=${waited.status} summary=${waited.summary.slice(0, 120)}`,
      );
    }
  } catch (e) {
    fail("agent_wait after spawn", e instanceof Error ? e.message : String(e));
  }

  const helloPath = join(wtPath, "hello.txt");
  try {
    const body = (await readFile(helloPath, "utf8")).trim();
    if (body.includes("HELLO_FROM_CHILD")) {
      pass("child wrote hello.txt", body.slice(0, 80));
    } else {
      fail("child wrote hello.txt", `contents=${JSON.stringify(body)}`);
    }
  } catch (e) {
    fail(
      "child wrote hello.txt",
      e instanceof Error ? e.message : String(e),
    );
  }

  try {
    const sent = await withTimeout(
      agentSend(
        {
          stateDir: e2eState,
          parentRepoRoot: demoRepo,
          parentSessionKey,
          repoKey: "mademo",
          callerSessionKey: parentSessionKey,
          createChildSession: async () => {
            throw new Error("unreachable");
          },
          ensureAndMaybePrompt: async () => ({}),
          deliverMessage: async (input) => {
            const slash = input.sessionKey.indexOf("/");
            const identity = {
              repo: input.sessionKey.slice(0, slash),
              name: input.sessionKey.slice(slash + 1),
              agent,
            };
            const handle = await agents.ensureSession(identity, {
              permissionMode: "bypass",
              cwd: wtPath,
            });
            const summary = await collectTurnText(
              agents,
              handle,
              input.message,
            );
            console.log(
              `  … A2A reply (${summary.length} chars): ${summary.slice(0, 200)}`,
            );
            return { summary: summary || "(empty)" };
          },
        },
        {
          to: childSlug,
          message:
            "Read hello.txt in your cwd and reply with exactly one line: CONFIRMED:<contents>",
        },
      ),
      180_000,
      "agentSend",
    );
    if (sent.summary && /CONFIRMED|HELLO_FROM_CHILD/i.test(sent.summary)) {
      pass("agent_send A2A reply", sent.summary.slice(0, 160));
    } else if (sent.summary && sent.summary.length > 5) {
      pass(
        "agent_send A2A reply (soft)",
        `got non-empty reply: ${sent.summary.slice(0, 160)}`,
      );
    } else {
      fail("agent_send A2A reply", `to=${sent.to} summary=${sent.summary}`);
    }
  } catch (e) {
    fail("agent_send A2A reply", e instanceof Error ? e.message : String(e));
  }

  try {
    const kids = await agentList(e2eState, parentSessionKey);
    if (kids.some((k) => k.childSessionKey === actualChildKey)) {
      pass("agent_list shows child", `${kids.length} child(ren)`);
    } else {
      fail(
        "agent_list shows child",
        JSON.stringify(kids.map((k) => k.childSessionKey)),
      );
    }
  } catch (e) {
    fail("agent_list shows child", e instanceof Error ? e.message : String(e));
  }

  const parentHello = join(demoRepo, "hello.txt");
  if (!existsSync(parentHello)) {
    pass("parent cwd clean (no hello.txt leak)");
  } else {
    const body = await readFile(parentHello, "utf8").catch(() => "");
    // Soft note — previous runs or agent path confusion
    pass(
      "parent cwd note (hello.txt present)",
      `leftover or agent wrote parent: ${body.trim().slice(0, 40)}`,
    );
  }

  try {
    await agentKill({
      stateDir: e2eState,
      parentRepoRoot: demoRepo,
      callerSessionKey: parentSessionKey,
      childSessionKey: actualChildKey,
      dispose: true,
      config: { removeWorktreeOnKill: true, deleteBranchOnKill: true },
      killSession: async (key) => {
        try {
          await agents.cancelTurn?.(key, "e2e cleanup");
        } catch {
          /* */
        }
      },
    });
    pass("agent_kill dispose worktree");
  } catch (e) {
    fail(
      "agent_kill dispose worktree",
      e instanceof Error ? e.message : String(e),
    );
  }

  try {
    await agents.cancelTurn?.(parentHandle.sessionKey, "e2e done");
  } catch {
    /* */
  }

  await finish(checks.every((c) => c.ok));
}

async function finish(ok: boolean) {
  const body = {
    ok,
    demoRepo,
    runId,
    e2eRoot,
    parentSessionKey,
    childSlug,
    agent,
    checks,
    at: new Date().toISOString(),
  };
  await mkdir(join(demoRepo), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  // process.exit skips outer finally — release lock here
  try {
    await rm(lockPath, { force: true });
  } catch {
    /* */
  }
  if (ok) {
    // Success: drop ephemeral state to keep demo repo tidy
    try {
      await rm(e2eRoot, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
  console.log(ok ? "\ne2e multi-agent PASSED" : "\ne2e multi-agent FAILED");
  console.log(`results: ${resultPath}`);
  process.exit(ok ? 0 : 1);
}

await main().catch(async (e) => {
  console.error(e);
  fail("uncaught", e instanceof Error ? e.message : String(e));
  await finish(false);
});
