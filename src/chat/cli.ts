/**
 * `acpbot chat` — multi-session terminal hub over acp-host.
 *
 *   acpbot chat                 interactive REPL
 *   acpbot chat ls              list sessions
 *   acpbot chat session <key>   set focus + one-shot optional -m
 *   acpbot chat -m "…"          one-shot prompt on focused (or --session)
 */
import * as readline from "node:readline";
import { resolve } from "node:path";
import { loadConfig } from "../config";
import {
  assertAcpHostReady,
  createAcpHostClient,
  resolveAcpHostSockPath,
} from "../acp-host/client";
import { createFileHostSessionStore } from "../acp/session-store";
import { createTtyPermissionHooks } from "./permissions-tty";
import { renderTurnStream, type TurnRenderMode } from "./render-turn";
import { streamTurn } from "./turn";
import {
  formatSessionKey,
  formatSessionTree,
  loadFocus,
  mergeSessionLists,
  parseSessionKey,
  resolveSessionRef,
  saveFocus,
  slotsToRefs,
  type ChatSessionRef,
} from "./sessions";

export function isChatCliCommand(argv: string[]): boolean {
  const a = argv.slice(2).map((s) => s.toLowerCase());
  return a[0] === "chat";
}

export function chatCliHelp(): string {
  return `Chat (multi-session hub — requires \`acpbot host\`):

  acpbot chat                      Interactive REPL (focus + free-text)
  acpbot chat ls                   List host sessions
  acpbot chat session <key>        Set focus (repo/name or #n)
  acpbot chat -m "prompt"          One-shot on focused session
  acpbot chat session <key> -m "…" One-shot on a specific session

REPL commands:
  /sessions | /ls     List sessions (* = focus)
  /use <key|#n>       Change focus
  /new <repo> [name]  Ensure new session and focus
  /status             Focus + session summary
  /cancel             Cancel in-flight turn on focus
  /fresh              New ACP conversation on focus (history cleared)
  /spawn <slug> [prompt…]   Child worktree under focus (host-only)
  /kill [key]         Kill host slot / spawn child (default: focus)
  /exit | /quit       Leave REPL

Flags:
  --bypass            Auto-allow tool permissions (default: TTY ask)
  --quiet             Assistant text only (hide thoughts/tools/status)
  --session <key>     Focus for one-shot
  --agent <id>        Agent id (default: config default_agent)
  --repo <key>        Default repo for /new short form

By default the CLI prints full agent output: thoughts (dim), tools with
status/input snippets, assistant text, and turn status. Use --quiet for
text-only (handy when piping).`;
}

type ChatFlags = {
  bypass: boolean;
  quiet: boolean;
  message?: string;
  session?: string;
  agent?: string;
  repo?: string;
  rest: string[];
};

function parseChatArgs(argv: string[]): ChatFlags {
  const args = argv.slice(2);
  // drop leading "chat"
  if (args[0]?.toLowerCase() === "chat") args.shift();
  const out: ChatFlags = { bypass: false, quiet: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--bypass") {
      out.bypass = true;
      continue;
    }
    if (a === "--quiet" || a === "-q") {
      out.quiet = true;
      continue;
    }
    if (a === "-m" || a === "--message") {
      const v = args[++i];
      if (v !== undefined) out.message = v;
      continue;
    }
    if (a === "--session" || a === "-s") {
      const v = args[++i];
      if (v !== undefined) out.session = v;
      continue;
    }
    if (a === "--agent") {
      const v = args[++i];
      if (v !== undefined) out.agent = v;
      continue;
    }
    if (a === "--repo") {
      const v = args[++i];
      if (v !== undefined) out.repo = v;
      continue;
    }
    if (a === "-h" || a === "--help" || a === "help") {
      out.rest.push("help");
      continue;
    }
    out.rest.push(a);
  }
  return out;
}

export async function runChatCli(argv: string[] = process.argv): Promise<number> {
  const flags = parseChatArgs(argv);
  if (flags.rest[0] === "help") {
    console.log(chatCliHelp());
    return 0;
  }

  const cfg = loadConfig({ requireTelegram: false });
  const stateDir = cfg.stateDir;
  const sockPath = resolveAcpHostSockPath(stateDir);
  await assertAcpHostReady({ sockPath, stateDir });

  const permissionMode = flags.bypass ? "bypass" : "ask";
  const renderMode: TurnRenderMode = flags.quiet ? "quiet" : "full";
  const hooks = createTtyPermissionHooks({
    mode: permissionMode,
    isTty: process.stdin.isTTY,
  });
  const host = createAcpHostClient({ sockPath, hooks });
  const store = createFileHostSessionStore(stateDir);
  const defaultAgent =
    flags.agent?.trim() || cfg.defaultAgent || "grok-build";
  const repos = cfg.repos ?? {};
  const defaultRepo =
    flags.repo?.trim() ||
    Object.keys(repos)[0] ||
    undefined;

  const sub = (flags.rest[0] ?? "").toLowerCase();

  try {
    if (sub === "ls" || sub === "list" || sub === "sessions") {
      const sessions = await listAll(host, store);
      const focus = await loadFocus(stateDir);
      console.log(formatSessionTree(sessions, focus.focusKey));
      return 0;
    }

    if (sub === "session" || sub === "use") {
      const token = flags.rest[1] ?? flags.session;
      if (!token) {
        console.error("usage: acpbot chat session <key|#n>");
        return 2;
      }
      const sessions = await listAll(host, store);
      const ref = resolveSessionRef(
        token,
        sessions,
        defaultRepo ? { defaultRepo } : undefined,
      );
      await ensureRef(host, ref, defaultAgent, repos, permissionMode);
      await saveFocus(stateDir, ref.sessionKey);
      console.log(`focus → ${ref.sessionKey}`);
      if (flags.message?.trim()) {
        return await runOneShot(
          host,
          ref,
          flags.message,
          defaultAgent,
          repos,
          permissionMode,
          renderMode,
        );
      }
      return 0;
    }

    // one-shot without subcommand
    if (flags.message?.trim() && !sub) {
      const focus = await loadFocus(stateDir);
      const sessions = await listAll(host, store);
      const key = flags.session || focus.focusKey;
      if (!key) {
        console.error("no focused session — use: acpbot chat session <key> -m \"…\"");
        return 2;
      }
      const ref = resolveSessionRef(
        key,
        sessions,
        defaultRepo ? { defaultRepo } : undefined,
      );
      await ensureRef(host, ref, defaultAgent, repos, permissionMode);
      await saveFocus(stateDir, ref.sessionKey);
      return await runOneShot(
        host,
        ref,
        flags.message,
        defaultAgent,
        repos,
        permissionMode,
        renderMode,
      );
    }

    // interactive REPL
    return await runRepl({
      host,
      store,
      stateDir,
      defaultAgent,
      repos,
      permissionMode,
      renderMode,
      ...(defaultRepo ? { defaultRepo } : {}),
      ...(flags.session ? { initialFocus: flags.session } : {}),
    });
  } finally {
    await host.dispose().catch(() => {});
  }
}

async function listAll(
  host: ReturnType<typeof createAcpHostClient>,
  store: ReturnType<typeof createFileHostSessionStore>,
): Promise<ChatSessionRef[]> {
  const [slots, durable] = await Promise.all([
    host.listSlots().catch(() => []),
    store.list().catch(() => []),
  ]);
  return mergeSessionLists(
    slotsToRefs(slots),
    durable.map((d) => ({
      sessionKey: d.sessionKey,
      agent: d.agent,
      cwd: d.cwd,
    })),
  );
}

async function ensureRef(
  host: ReturnType<typeof createAcpHostClient>,
  ref: ChatSessionRef,
  defaultAgent: string,
  repos: Record<string, string>,
  permissionMode: "ask" | "bypass",
): Promise<ChatSessionRef> {
  const agent = ref.agent || defaultAgent;
  let cwd = ref.cwd;
  if (!cwd) {
    const { repo } = parseSessionKey(ref.sessionKey);
    const repoPath = repos[repo];
    if (!repoPath) {
      throw new Error(
        `no cwd for repo "${repo}" — set [repos] in config.toml`,
      );
    }
    cwd = resolve(repoPath);
  }
  await host.ensureSession({
    sessionKey: ref.sessionKey,
    agent,
    cwd,
    permissionMode,
  });
  return { ...ref, agent, cwd };
}

async function runOneShot(
  host: ReturnType<typeof createAcpHostClient>,
  ref: ChatSessionRef,
  message: string,
  defaultAgent: string,
  repos: Record<string, string>,
  permissionMode: "ask" | "bypass",
  renderMode: TurnRenderMode,
): Promise<number> {
  const r = await ensureRef(host, ref, defaultAgent, repos, permissionMode);
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.once("SIGINT", onSig);
  try {
    const result = await renderTurnStream(
      streamTurn(host, {
        sessionKey: r.sessionKey,
        agent: r.agent || defaultAgent,
        cwd: r.cwd,
        text: message,
        permissionMode,
        signal: ac.signal,
      }),
      { mode: renderMode },
    );
    return result.status === "completed" || result.status === "end_turn"
      ? 0
      : 1;
  } finally {
    process.off("SIGINT", onSig);
  }
}

async function runRepl(input: {
  host: ReturnType<typeof createAcpHostClient>;
  store: ReturnType<typeof createFileHostSessionStore>;
  stateDir: string;
  defaultAgent: string;
  repos: Record<string, string>;
  defaultRepo?: string;
  permissionMode: "ask" | "bypass";
  renderMode: TurnRenderMode;
  initialFocus?: string;
}): Promise<number> {
  const {
    host,
    store,
    stateDir,
    defaultAgent,
    repos,
    defaultRepo,
    permissionMode,
    renderMode,
  } = input;

  let focus = await loadFocus(stateDir);
  if (input.initialFocus) {
    const sessions = await listAll(host, store);
    const ref = resolveSessionRef(
      input.initialFocus,
      sessions,
      defaultRepo ? { defaultRepo } : undefined,
    );
    await ensureRef(host, ref, defaultAgent, repos, permissionMode);
    focus = await saveFocus(stateDir, ref.sessionKey);
  }

  console.log("acpbot chat — multi-session hub (host required)");
  console.log(
    `permissions: ${permissionMode}  ·  output: ${renderMode}  ·  /help`,
  );
  if (focus.focusKey) console.log(`focus: ${focus.focusKey}`);
  else console.log("focus: (none) — /new <repo> [name] or /use <key>");

  if (!process.stdin.isTTY) {
    console.error("REPL needs a TTY — use -m for one-shot");
    return 2;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = () => {
    const p = focus.focusKey ? `chat:${focus.focusKey}> ` : "chat> ";
    rl.setPrompt(p);
    rl.prompt();
  };

  let busy = false;
  let turnAbort: AbortController | undefined;

  const handleLine = async (line: string) => {
    const raw = line.trim();
    if (!raw) {
      prompt();
      return;
    }

    if (raw === "/exit" || raw === "/quit") {
      rl.close();
      return;
    }

    if (raw === "/help" || raw === "/?") {
      console.log(chatCliHelp());
      prompt();
      return;
    }

    if (raw === "/sessions" || raw === "/ls") {
      const sessions = await listAll(host, store);
      const childrenByParent: Record<
        string,
        Array<{ sessionKey: string; agent?: string; status?: string; role?: string }>
      > = {};
      if (focus.focusKey) {
        try {
          const kids = await host.listSpawnChildren(focus.focusKey);
          for (const k of kids) {
            const p = k.parentSessionKey;
            (childrenByParent[p] ??= []).push({
              sessionKey: k.childSessionKey,
              agent: k.agent,
              status: k.status,
              ...(k.role ? { role: k.role } : {}),
            });
          }
        } catch {
          /* */
        }
      }
      // Also list children for every root in the list
      for (const s of sessions) {
        if (s.sessionKey.includes("--")) continue;
        if (childrenByParent[s.sessionKey]) continue;
        try {
          const kids = await host.listSpawnChildren(s.sessionKey);
          for (const k of kids) {
            (childrenByParent[k.parentSessionKey] ??= []).push({
              sessionKey: k.childSessionKey,
              agent: k.agent,
              status: k.status,
              ...(k.role ? { role: k.role } : {}),
            });
          }
        } catch {
          /* */
        }
      }
      console.log(
        formatSessionTree(sessions, focus.focusKey, { childrenByParent }),
      );
      prompt();
      return;
    }

    if (raw === "/status") {
      console.log(`focus: ${focus.focusKey ?? "(none)"}`);
      console.log(`agent default: ${defaultAgent}`);
      console.log(`permission: ${permissionMode}`);
      prompt();
      return;
    }

    if (raw.startsWith("/use ") || raw.startsWith("/session ")) {
      const token = raw.replace(/^\/(use|session)\s+/, "").trim();
      try {
        const sessions = await listAll(host, store);
        const ref = resolveSessionRef(
          token,
          sessions,
          defaultRepo ? { defaultRepo } : undefined,
        );
        await ensureRef(host, ref, defaultAgent, repos, permissionMode);
        focus = await saveFocus(stateDir, ref.sessionKey);
        console.log(`focus → ${ref.sessionKey}`);
      } catch (e) {
        console.error(e instanceof Error ? e.message : e);
      }
      prompt();
      return;
    }

    if (raw.startsWith("/new")) {
      const parts = raw.slice(4).trim().split(/\s+/).filter(Boolean);
      const repo = parts[0] || defaultRepo;
      const name = parts[1] || "main";
      if (!repo) {
        console.error("usage: /new <repo> [name]");
        prompt();
        return;
      }
      if (!repos[repo]) {
        console.error(`unknown repo "${repo}" — keys: ${Object.keys(repos).join(", ") || "(none)"}`);
        prompt();
        return;
      }
      const key = formatSessionKey(repo, name);
      try {
        const ref = await ensureRef(
          host,
          { sessionKey: key, agent: defaultAgent, cwd: resolve(repos[repo]!) },
          defaultAgent,
          repos,
          permissionMode,
        );
        focus = await saveFocus(stateDir, ref.sessionKey);
        console.log(`focus → ${ref.sessionKey}`);
      } catch (e) {
        console.error(e instanceof Error ? e.message : e);
      }
      prompt();
      return;
    }

    if (raw === "/cancel") {
      if (turnAbort) {
        turnAbort.abort();
        console.log("cancel requested");
      } else if (focus.focusKey) {
        await host.cancel(focus.focusKey, "cli /cancel").catch(() => {});
        console.log("cancel sent");
      } else {
        console.log("nothing to cancel");
      }
      prompt();
      return;
    }

    if (raw === "/fresh") {
      if (!focus.focusKey) {
        console.error("no focus");
        prompt();
        return;
      }
      try {
        const sessions = await listAll(host, store);
        const ref = resolveSessionRef(
          focus.focusKey,
          sessions,
          defaultRepo ? { defaultRepo } : undefined,
        );
        const r = await ensureRef(host, ref, defaultAgent, repos, permissionMode);
        await host.ensureSession({
          sessionKey: r.sessionKey,
          agent: r.agent || defaultAgent,
          cwd: r.cwd,
          permissionMode,
          forceNewSession: true,
        });
        console.log(`fresh session on ${r.sessionKey}`);
      } catch (e) {
        console.error(e instanceof Error ? e.message : e);
      }
      prompt();
      return;
    }

    if (raw.startsWith("/spawn")) {
      if (!focus.focusKey) {
        console.error("no focus — /use or /new first");
        prompt();
        return;
      }
      // /spawn <slug> [--agent id] [prompt…]
      const body = raw.slice(6).trim();
      if (!body) {
        console.error("usage: /spawn <slug> [--agent id] [kickoff prompt]");
        prompt();
        return;
      }
      const tokens = body.split(/\s+/);
      let agent = defaultAgent;
      const nameParts: string[] = [];
      const promptParts: string[] = [];
      let phase: "name" | "prompt" = "name";
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (t === "--agent" && tokens[i + 1]) {
          agent = tokens[++i]!;
          continue;
        }
        if (phase === "name" && nameParts.length === 0) {
          nameParts.push(t);
          phase = "prompt";
          continue;
        }
        promptParts.push(t);
      }
      const slug = nameParts[0];
      if (!slug) {
        console.error("usage: /spawn <slug> [--agent id] [kickoff prompt]");
        prompt();
        return;
      }
      try {
        const rec = await host.spawnChild({
          parentSlotKey: focus.focusKey,
          name: slug,
          agent,
          permissionMode: "bypass",
          ...(promptParts.length
            ? { prompt: promptParts.join(" ") }
            : {}),
        });
        console.log(
          `spawned ${rec.childSessionKey} [${rec.agent}] status=${rec.status}`,
        );
        console.log(`  worktree: ${rec.worktreePath}`);
        console.log(`  branch:   ${rec.branch}`);
        console.log(`  /use ${slug}  to focus`);
      } catch (e) {
        console.error(e instanceof Error ? e.message : e);
      }
      prompt();
      return;
    }

    if (raw.startsWith("/kill")) {
      const token = raw.slice(5).trim();
      try {
        const sessions = await listAll(host, store);
        const key =
          token ||
          focus.focusKey ||
          (() => {
            throw new Error("no session — /kill <key> or set focus");
          })();
        const ref = resolveSessionRef(
          key,
          sessions,
          defaultRepo ? { defaultRepo } : undefined,
        );
        // Spawn-registry kill when key is a child (…--slug)
        const dd = ref.sessionKey.lastIndexOf("--");
        if (dd > 0) {
          const parentFromChild = ref.sessionKey.slice(0, dd);
          try {
            await host.killSpawnChild({
              parentSlotKey: parentFromChild,
              childSlotKey: ref.sessionKey,
              dispose: true,
            });
          } catch {
            await host.killSlot(ref.sessionKey);
          }
        } else {
          await host.killSlot(ref.sessionKey);
        }
        if (focus.focusKey === ref.sessionKey) {
          focus = await saveFocus(stateDir, null);
        }
        console.log(`killed ${ref.sessionKey}`);
      } catch (e) {
        console.error(e instanceof Error ? e.message : e);
      }
      prompt();
      return;
    }

    // free text → focused turn
    if (raw.startsWith("/")) {
      console.error(`unknown command ${raw.split(/\s/)[0]} — /help`);
      prompt();
      return;
    }
    if (!focus.focusKey) {
      console.error("no focus — /new <repo> or /use <key>");
      prompt();
      return;
    }
    if (busy) {
      console.error("busy — /cancel or wait");
      prompt();
      return;
    }

    busy = true;
    turnAbort = new AbortController();
    try {
      const sessions = await listAll(host, store);
      const ref = resolveSessionRef(
        focus.focusKey,
        sessions,
        defaultRepo ? { defaultRepo } : undefined,
      );
      const r = await ensureRef(host, ref, defaultAgent, repos, permissionMode);
      await renderTurnStream(
        streamTurn(host, {
          sessionKey: r.sessionKey,
          agent: r.agent || defaultAgent,
          cwd: r.cwd,
          text: raw,
          permissionMode,
          signal: turnAbort.signal,
        }),
        { mode: renderMode },
      );
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
    } finally {
      busy = false;
      turnAbort = undefined;
      prompt();
    }
  };

  rl.on("line", (line) => {
    void handleLine(line);
  });
  rl.on("close", () => {
    turnAbort?.abort();
  });

  prompt();
  await new Promise<void>((resolve) => rl.on("close", () => resolve()));
  return 0;
}
