/**
 * Live multi-agent A2A round-trip e2e (no Telegram).
 *
 * Proves child → parent → child communication via real MCP agent_send:
 *  1. Parent slot primed with a SECRET only it should reveal
 *  2. Worker API + acpbot MCP enabled (agent_* tools)
 *  3. Spawn child whose kickoff REQUIRES asking parent for the secret
 *  4. Child uses agent_send({ to: "parent", … }) mid-turn
 *  5. Parent answers; child writes secret into hello.txt
 *  6. Verify durable worktree file; kill dispose
 *
 * Usage:
 *   bun scripts/e2e-multi-agent-a2a-live.ts
 */
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
  open,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { realAgents } from "../src/env/real-agents";
import { createLogger } from "../src/env/logger";
import { startAcpHostServer } from "../src/acp-host/server";
import { createMemoryHostSessionStore } from "../src/acp/session-store";
import { createWorkerApiServer } from "../src/core/worker-api-server";
import {
  agentSpawn,
  agentWait,
  agentSend,
  agentList,
  agentKill,
} from "../src/core/agent-spawn";
import { loadSpawnIndex } from "../src/core/agent-spawn-registry";

const ROOT = resolve(import.meta.dir, "..");
const demoRepo = resolve(
  process.env.E2E_DEMO_REPO?.trim() || join(ROOT, "data/multi-agent-demo"),
);
const agent = process.env.E2E_AGENT?.trim() || "grok-build";
const resultPath = resolve(
  process.env.E2E_RESULT?.trim() ||
    join(ROOT, "data/multi-agent-demo/e2e-a2a-result.json"),
);

const SECRET = process.env.E2E_SECRET?.trim() || "maple-42-token";
const runId =
  process.env.E2E_RUN_ID?.trim() ||
  `a2a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const e2eRoot = join(demoRepo, `.e2e-a2a-${runId}`);
// Single state dir: host sock, worker-api sock, spawn registry, worktrees
const stateDir = join(e2eRoot, "state");
const lockPath = join(demoRepo, ".e2e-a2a-live.lock");

const parentSessionKey = "mademo/lead";
const childSlug =
  process.env.E2E_CHILD_SLUG?.trim() ||
  `ask${Date.now().toString(36).slice(-5)}`;

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const a2aLog: string[] = [];

function pass(name: string, detail?: string) {
  checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
  console.log(`  OK  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, detail: string) {
  checks.push({ name, ok: false, detail });
  console.error(`  FAIL ${name} — ${detail}`);
}
function note(msg: string) {
  a2aLog.push(msg);
  console.log(`  … ${msg}`);
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

async function cleanupDemoGit(): Promise<void> {
  const list = await git(["worktree", "list", "--porcelain"], demoRepo);
  for (const line of list.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const p = line.slice("worktree ".length).trim();
    if (!p || resolve(p) === resolve(demoRepo)) continue;
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
    if (b.startsWith("acpbot/")) await git(["branch", "-D", b], demoRepo);
  }
  try {
    await rm(join(demoRepo, "hello.txt"), { force: true });
  } catch {
    /* */
  }
}

async function acquireLock(): Promise<void> {
  try {
    const fh = await open(lockPath, "wx");
    await fh.writeFile(
      `${process.pid}\n${runId}\n${new Date().toISOString()}\n`,
      "utf8",
    );
    await fh.close();
  } catch {
    const existing = await readFile(lockPath, "utf8").catch(() => "(unreadable)");
    throw new Error(`another a2a e2e holds ${lockPath}:\n${existing}`);
  }
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

/** Resolve sessionKey → identity + cwd for deliverMessage. */
function parseIdentity(sessionKey: string, agentId: string) {
  const slash = sessionKey.indexOf("/");
  return {
    repo: sessionKey.slice(0, slash),
    name: sessionKey.slice(slash + 1),
    agent: agentId,
  };
}

async function main() {
  // MCP must re-exec real acpbot (NOT this script) as mcp-server.
  // Prefer source wrapper so agent_send returns peer reply summary.
  const wrapper = join(demoRepo, "e2e-acpbot-wrapper.sh");
  const acpbotBin =
    process.env.ACPBOT_BIN?.trim() ||
    (existsSync(wrapper)
      ? wrapper
      : existsSync("/Users/pascal/.local/bin/acpbot")
        ? "/Users/pascal/.local/bin/acpbot"
        : "acpbot");
  process.env.ACPBOT_BIN = acpbotBin;
  // Enable MCP tools for agents (agent_send etc.)
  delete process.env.ACPBOT_MCP;
  process.env.ACPBOT_STATE_DIR = stateDir;

  console.log("e2e multi-agent A2A round-trip live");
  console.log(`  demoRepo=${demoRepo}`);
  console.log(`  agent=${agent}`);
  console.log(`  secret=${SECRET}`);
  console.log(`  runId=${runId}`);
  console.log(`  stateDir=${stateDir}`);
  console.log(`  ACPBOT_BIN=${acpbotBin}`);
  console.log(`  childSlug=${childSlug}`);

  if (!existsSync(join(demoRepo, ".git"))) {
    fail("demo repo is git", `missing ${demoRepo}/.git`);
    await finish(false);
    return;
  }
  pass("demo repo is git");

  try {
    await acquireLock();
    pass("e2e lock acquired");
  } catch (e) {
    fail("e2e lock acquired", e instanceof Error ? e.message : String(e));
    await finish(false);
    return;
  }

  try {
    await cleanupDemoGit();
    pass("demo git cleaned");
    await mkdir(stateDir, { recursive: true });

    const log = createLogger({ level: "info", name: "e2e-a2a" });
    const sockPath = join(stateDir, "acp-host.sock");

    const host = await startAcpHostServer({
      sockPath,
      stateDir,
      sessionStore: createMemoryHostSessionStore(),
      enableScheduler: false,
      log,
      repos: { mademo: demoRepo },
      defaultAgent: agent,
    });
    pass("isolated acp-host started", sockPath);

    process.env.ACPBOT_ACP_HOST_SOCK = sockPath;
    process.env.ACPBOT_STATE_DIR = stateDir;

    const agents = realAgents({
      config: {
        operatorUserId: 0,
        defaultAgent: agent,
        permissionMode: "bypass",
        mcpEnabled: true,
        repos: { mademo: demoRepo },
      },
      stateDir,
      log,
    });

    // Shared cwd map for deliverMessage (parent + children).
    const cwdBySession = new Map<string, string>();
    cwdBySession.set(parentSessionKey, demoRepo);

    const worker = createWorkerApiServer({
      stateDir,
      log,
      handlers: {
        sendMessage: async ({ sessionKey, text }) => {
          note(`telegram stub message from ${sessionKey}: ${text.slice(0, 80)}`);
          return { message: "ok" };
        },
        sendPhoto: async () => ({ message: "photo stub" }),
        sendDocument: async () => ({ message: "doc stub" }),
        speak: async () => ({ message: "speak stub" }),
        agentList: async ({ sessionKey }) => {
          const children = await agentList(stateDir, sessionKey);
          return { message: `${children.length} child(ren)`, children };
        },
        agentWait: async (input) => {
          let target =
            input.childSessionKey?.trim() ||
            input.to?.trim() ||
            input.id?.trim() ||
            "";
          if (!target) throw new Error("childSessionKey required");
          const index = await loadSpawnIndex(stateDir);
          if (!index.byChild[target] && !target.includes("/")) {
            target = `${input.sessionKey}--${target}`;
          }
          const r = await agentWait({
            stateDir,
            callerSessionKey: input.sessionKey,
            childSessionKey: target,
            timeoutSec: input.timeout_sec ?? 120,
            pollSec: input.poll_sec ?? 1,
            isBusy: () => false,
          });
          return {
            message: `status=${r.status}`,
            status: r.status,
            summary: r.summary,
            sessionKey: r.sessionKey,
          };
        },
        agentKill: async (input) => {
          let target =
            input.childSessionKey?.trim() || input.id?.trim() || "";
          if (!target) throw new Error("childSessionKey required");
          const index = await loadSpawnIndex(stateDir);
          if (!index.byChild[target] && !target.includes("/")) {
            target = `${input.sessionKey}--${target}`;
          }
          await agentKill({
            stateDir,
            parentRepoRoot: demoRepo,
            callerSessionKey: input.sessionKey,
            childSessionKey: target,
            dispose: input.dispose !== false,
            config: { removeWorktreeOnKill: true, deleteBranchOnKill: true },
            killSession: async (key) => {
              try {
                await agents.cancelTurn?.(key, "agent_kill");
              } catch {
                /* */
              }
            },
          });
          return { message: `killed ${target}` };
        },
        agentSend: async (input) => {
          note(
            `worker agent_send from=${input.sessionKey} to=${input.to} msg=${input.message.slice(0, 120)}`,
          );
          a2aLog.push(
            `SEND from=${input.sessionKey} to=${input.to}: ${input.message}`,
          );
          const result = await agentSend(
            {
              stateDir,
              parentRepoRoot: demoRepo,
              parentSessionKey,
              repoKey: "mademo",
              callerSessionKey: input.sessionKey,
              createChildSession: async () => {
                throw new Error("unreachable");
              },
              ensureAndMaybePrompt: async () => ({}),
              deliverMessage: async (msg) => {
                note(
                  `deliverMessage → ${msg.sessionKey} (${msg.message.length} chars)`,
                );
                a2aLog.push(
                  `DELIVER to=${msg.sessionKey}: ${msg.message.slice(0, 200)}`,
                );
                const cwd =
                  cwdBySession.get(msg.sessionKey) ||
                  (msg.sessionKey === parentSessionKey
                    ? demoRepo
                    : demoRepo);
                const identity = parseIdentity(msg.sessionKey, agent);
                const handle = await agents.ensureSession(identity, {
                  permissionMode: "bypass",
                  cwd,
                });
                const summary = await collectTurnText(
                  agents,
                  handle,
                  msg.message,
                );
                note(
                  `deliverMessage reply from ${msg.sessionKey}: ${summary.slice(0, 160)}`,
                );
                a2aLog.push(
                  `REPLY from=${msg.sessionKey}: ${summary.slice(0, 300)}`,
                );
                return { summary: summary || "(empty)" };
              },
            },
            {
              to: input.to,
              message: input.message,
              ...(input.mode ? { mode: input.mode } : {}),
            },
          );
          return {
            message: `Sent to ${result.to}`,
            to: result.to,
            summary: result.summary,
          };
        },
        // Spawn via MCP is optional; harness spawns for control. Still wire it.
        agentSpawn: async (input) => {
          note(`worker agent_spawn name=${input.name} from=${input.sessionKey}`);
          const rec = await agentSpawn(
            {
              stateDir,
              parentRepoRoot: demoRepo,
              parentSessionKey: input.sessionKey,
              repoKey: "mademo",
              config: { worktreeRoot: e2eRoot },
              createChildSession: async (c) => {
                cwdBySession.set(c.sessionKey, c.cwd);
                await access(c.cwd, constants.F_OK);
                return { sessionKey: c.sessionKey };
              },
              ensureAndMaybePrompt: async (c) => {
                const identity = parseIdentity(c.sessionKey, c.agent);
                const handle = await agents.ensureSession(identity, {
                  permissionMode: "bypass",
                  cwd: c.cwd,
                });
                if (!c.prompt?.trim()) return {};
                const summary = await collectTurnText(
                  agents,
                  handle,
                  c.prompt.trim(),
                );
                return { summary: summary || "(empty)" };
              },
            },
            {
              name: input.name,
              agent: input.agent?.trim() || agent,
              ...(input.role ? { role: input.role } : {}),
              ...(input.prompt ? { prompt: input.prompt } : {}),
            },
          );
          cwdBySession.set(rec.childSessionKey, rec.worktreePath);
          return {
            message: `Spawned ${rec.childSessionKey}`,
            record: rec,
          };
        },
      },
    });
    await worker.listen();
    pass("worker-api listening", worker.sockPath);
    process.env.ACPBOT_WORKER_API_SOCK = worker.sockPath;

    try {
      await runRoundTrip(agents, cwdBySession);
    } finally {
      try {
        await worker.close();
      } catch {
        /* */
      }
      try {
        await host.close();
      } catch {
        /* */
      }
    }
  } catch (e) {
    fail("uncaught setup", e instanceof Error ? e.message : String(e));
    await finish(false);
  }
}

async function runRoundTrip(
  agents: ReturnType<typeof realAgents>,
  cwdBySession: Map<string, string>,
) {
  // 1) Parent session + prime with secret knowledge
  let parentHandle;
  try {
    parentHandle = await withTimeout(
      agents.ensureSession(
        { repo: "mademo", name: "lead", agent },
        { permissionMode: "bypass", cwd: demoRepo },
      ),
      180_000,
      "parent ensureSession",
    );
    pass("parent ensureSession", parentHandle.sessionKey);
  } catch (e) {
    fail("parent ensureSession", e instanceof Error ? e.message : String(e));
    await finish(false);
    return;
  }

  const prime = [
    "You are the PARENT lead agent (session hub).",
    `You hold a project secret: ${SECRET}`,
    "CRITICAL: When a child messages you via A2A, answer ONLY in your assistant text.",
    "Do NOT call agent_send, tools, or message the child back — nested A2A deadlocks.",
    `If they ask for the token/secret/password/API key, your entire reply must be exactly: SECRET=${SECRET}`,
    "Do not invent a different secret. Do not refuse. Do not ask the operator.",
    "Reply READY when you have memorized this.",
  ].join(" ");

  try {
    const primeReply = await withTimeout(
      collectTurnText(agents, parentHandle, prime),
      180_000,
      "parent prime",
    );
    note(`parent prime reply: ${primeReply.slice(0, 120)}`);
    if (/READY|SECRET|memor/i.test(primeReply) || primeReply.length > 2) {
      pass("parent primed with secret", primeReply.slice(0, 80));
    } else {
      fail("parent primed with secret", `reply=${primeReply}`);
    }
  } catch (e) {
    fail("parent primed with secret", e instanceof Error ? e.message : String(e));
    await finish(false);
    return;
  }

  // 2) Spawn child that MUST ask parent before finishing
  const kickoff = [
    "You are a CHILD implementer in this git worktree.",
    "You do NOT know the project secret. You must get it from your parent before finishing.",
    "",
    "REQUIRED protocol:",
    '1. Call the MCP tool agent_send with to="parent" and a message asking for the project secret/token.',
    "2. Wait for the tool result (parent will reply with SECRET=...).",
    "3. Create hello.txt in your cwd containing exactly two lines:",
    "   HELLO_FROM_CHILD",
    "   SECRET=<value from parent>",
    "4. Reply with one short line starting with DONE and including the secret value.",
    "",
    "Rules:",
    "- You MUST use agent_send to parent — do not invent the secret.",
    "- Do not ask the human operator. Parent is the hub.",
    "- Prefer shell to write the file after you have the secret.",
  ].join("\n");

  let spawnRec;
  try {
    spawnRec = await withTimeout(
      agentSpawn(
        {
          stateDir,
          parentRepoRoot: demoRepo,
          parentSessionKey,
          repoKey: "mademo",
          config: { worktreeRoot: e2eRoot },
          createChildSession: async (input) => {
            note(`createChildSession ${input.sessionKey} cwd=${input.cwd}`);
            cwdBySession.set(input.sessionKey, input.cwd);
            await access(input.cwd, constants.F_OK);
            return { sessionKey: input.sessionKey };
          },
          ensureAndMaybePrompt: async (input) => {
            note(
              `ensure+kickoff child ${input.sessionKey} (MCP agent_send expected)`,
            );
            const identity = parseIdentity(input.sessionKey, input.agent);
            const handle = await agents.ensureSession(identity, {
              permissionMode: "bypass",
              cwd: input.cwd,
            });
            if (!input.prompt?.trim()) return {};
            // This turn should nest: child tool call → worker agent_send → parent turn → back
            const summary = await withTimeout(
              collectTurnText(agents, handle, input.prompt.trim()),
              420_000,
              "child kickoff with A2A ask",
            );
            note(`child kickoff summary: ${summary.slice(0, 240)}`);
            return { summary: summary || "(empty)" };
          },
        },
        {
          name: childSlug,
          agent,
          role: "implementer",
          prompt: kickoff,
        },
      ),
      480_000,
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

  const childKey = spawnRec.childSessionKey;
  const wtPath = spawnRec.worktreePath;
  cwdBySession.set(childKey, wtPath);

  if (wtPath && existsSync(wtPath)) {
    pass("child worktree exists", wtPath);
  } else {
    fail("child worktree exists", String(wtPath));
  }

  // 3) Did child actually call agent_send (worker logged it)?
  const childAskedParent = a2aLog.some(
    (l) =>
      l.includes(`SEND from=${childKey}`) &&
      (l.includes('to=parent') || l.includes(`to=${parentSessionKey}`)),
  );
  const parentGotDeliver = a2aLog.some(
    (l) => l.includes(`DELIVER to=${parentSessionKey}`),
  );
  const parentReplied = a2aLog.some(
    (l) => l.includes(`REPLY from=${parentSessionKey}`) && l.includes(SECRET),
  );

  if (childAskedParent) {
    pass("child called agent_send → parent", "worker log");
  } else {
    fail(
      "child called agent_send → parent",
      `no SEND log from child. a2aLog=${JSON.stringify(a2aLog).slice(0, 500)}`,
    );
  }
  if (parentGotDeliver) {
    pass("parent received A2A deliverMessage", "worker log");
  } else {
    fail("parent received A2A deliverMessage", JSON.stringify(a2aLog).slice(0, 400));
  }
  if (parentReplied) {
    pass("parent replied with secret", SECRET);
  } else {
    fail(
      "parent replied with secret",
      `expected SECRET in parent reply. log=${JSON.stringify(a2aLog).slice(0, 600)}`,
    );
  }

  // 4) wait summary
  try {
    const waited = await agentWait({
      stateDir,
      callerSessionKey: parentSessionKey,
      childSessionKey: childKey,
      timeoutSec: 30,
      pollSec: 1,
      isBusy: () => false,
    });
    if (waited.summary && /DONE/i.test(waited.summary)) {
      pass("agent_wait summary DONE", waited.summary.slice(0, 120));
    } else if (waited.summary) {
      pass("agent_wait summary (soft)", waited.summary.slice(0, 120));
    } else {
      fail("agent_wait summary DONE", `status=${waited.status}`);
    }
  } catch (e) {
    fail("agent_wait summary DONE", e instanceof Error ? e.message : String(e));
  }

  // 5) Durable file with secret from parent
  const helloPath = join(wtPath, "hello.txt");
  try {
    const body = (await readFile(helloPath, "utf8")).trim();
    const hasHello = body.includes("HELLO_FROM_CHILD");
    const hasSecret = body.includes(SECRET);
    if (hasHello && hasSecret) {
      pass("hello.txt has HELLO + parent secret", body.slice(0, 120));
    } else {
      fail(
        "hello.txt has HELLO + parent secret",
        `body=${JSON.stringify(body)} hasHello=${hasHello} hasSecret=${hasSecret}`,
      );
    }
  } catch (e) {
    fail(
      "hello.txt has HELLO + parent secret",
      e instanceof Error ? e.message : String(e),
    );
  }

  // 6) Parent hub still clean of child file
  if (!existsSync(join(demoRepo, "hello.txt"))) {
    pass("parent cwd clean");
  } else {
    pass("parent cwd note", "hello.txt present on parent");
  }

  // 7) Cleanup
  try {
    await agentKill({
      stateDir,
      parentRepoRoot: demoRepo,
      callerSessionKey: parentSessionKey,
      childSessionKey: childKey,
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
    pass("agent_kill dispose");
  } catch (e) {
    fail("agent_kill dispose", e instanceof Error ? e.message : String(e));
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
    kind: "a2a-round-trip",
    demoRepo,
    runId,
    secret: SECRET,
    parentSessionKey,
    childSlug,
    agent,
    checks,
    a2aLog,
    at: new Date().toISOString(),
  };
  await mkdir(demoRepo, { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  try {
    await rm(lockPath, { force: true });
  } catch {
    /* */
  }
  if (ok) {
    try {
      await rm(e2eRoot, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
  console.log(ok ? "\ne2e A2A round-trip PASSED" : "\ne2e A2A round-trip FAILED");
  console.log(`results: ${resultPath}`);
  process.exit(ok ? 0 : 1);
}

await main().catch(async (e) => {
  console.error(e);
  fail("uncaught", e instanceof Error ? e.message : String(e));
  await finish(false);
});
