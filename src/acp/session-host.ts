/**
 * Thin ACP host: spawn agent stdio + official @agentclientprotocol/sdk client.
 * Replaces acpx/runtime for tacp's AgentsPort.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ElicitationDecision,
  PermissionDecision,
  PermissionRequest,
  ElicitationRequest,
} from "../env/types";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import { resolveAgentLaunch } from "./agent-launch";
import { decisionToPermissionResponse } from "./permission-map";
import { buildTacpMcpServers } from "../mcp/servers";
import type { TacpConfig } from "../env/types";
import { pickSessionModeId } from "./session-mode";
import {
  createFileHostSessionStore,
  type HostSessionRecord,
  type HostSessionStore,
} from "./session-store";

export type SessionHostHooks = {
  onPermissionRequest?: (
    req: PermissionRequest,
    ctx: { signal: AbortSignal },
  ) => Promise<PermissionDecision | undefined>;
  onElicitationRequest?: (
    req: ElicitationRequest,
    ctx: { signal: AbortSignal },
  ) => Promise<ElicitationDecision | undefined>;
  onAskUserQuestion?: (
    req: { sessionId: string; raw: unknown },
    ctx: { signal: AbortSignal },
  ) => Promise<Record<string, unknown>>;
};

export type SessionHostOptions = {
  config: TacpConfig;
  /**
   * Durable session records live under `<stateDir>/sessions/`.
   * When set, agentSessionId is persisted so restarts can session/load.
   */
  stateDir?: string;
  /** Inject store (tests). Overrides stateDir file store when provided. */
  sessionStore?: HostSessionStore;
  mcpEnabled?: boolean;
  log?: Logger;
  hooks?: SessionHostHooks;
};

export type HostSession = {
  sessionKey: string;
  agentSessionId: string;
  cwd: string;
  agent: string;
  currentModeId?: string | undefined;
  availableModeIds?: string[] | undefined;
};

export type HostModeState = {
  currentModeId: string | undefined;
  availableModeIds: string[];
};

type LiveSession = {
  sessionKey: string;
  agent: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  session: acp.ActiveSession;
  /** Last known ACP mode id (from new/load/setMode/updates) */
  currentModeId: string | undefined;
  availableModeIds: string[];
  /** Abort in-flight prompt / permission waits */
  turnAbort: AbortController | undefined;
};

/** Map session/update notification → simplified turn events for the daemon. */
export type HostTurnEvent =
  | { type: "text_delta"; text: string; stream?: "output" | "thought" }
  | {
      type: "tool_call";
      toolCallId?: string | undefined;
      title?: string | undefined;
      status?: string | undefined;
      rawInput?: unknown;
      kind?: string | undefined;
      locations?: unknown;
      rawOutput?: unknown;
      tag?: string | undefined;
      text?: string | undefined;
    }
  | { type: "done"; stopReason?: string | undefined }
  | { type: "error"; message: string };

export type HostTurn = {
  events: AsyncIterable<HostTurnEvent>;
  result: Promise<{ status: string; stopReason?: string; error?: { message?: string } }>;
  cancel: (reason?: string) => Promise<void>;
};

export type SessionHost = {
  ensureSession(input: {
    sessionKey: string;
    agent: string;
    cwd: string;
  }): Promise<HostSession>;
  startTurn(input: {
    sessionKey: string;
    text: string;
    attachments?: Array<{ mediaType: string; data: string }>;
    signal?: AbortSignal;
  }): HostTurn;
  cancel(sessionKey: string, reason?: string): Promise<void>;
  setMode(sessionKey: string, modeId: string): Promise<HostModeState>;
  getModeState(sessionKey: string): HostModeState | undefined;
  getAvailableModes(sessionKey: string): string[];
  setHooks(hooks: SessionHostHooks): void;
  dispose(): Promise<void>;
};

type TerminalRec = {
  id: string;
  child: ChildProcessWithoutNullStreams;
  output: string;
  exitCode: number | null;
  exited: Promise<void>;
};

function contentText(block: unknown): string | undefined {
  if (!block || typeof block !== "object") return undefined;
  const b = block as { type?: string; text?: string };
  if (b.type === "text" && typeof b.text === "string") return b.text;
  return undefined;
}

export function createSessionHost(options: SessionHostOptions): SessionHost {
  const log = (options.log ?? silentLogger()).child("acp-host");
  const live = new Map<string, LiveSession>();
  /** agent session id → tacp sessionKey */
  const agentIdToKey = new Map<string, string>();
  let hooks: SessionHostHooks = { ...options.hooks };
  const terminals = new Map<string, TerminalRec>();
  const sessionStore: HostSessionStore | undefined =
    options.sessionStore ??
    (options.stateDir
      ? createFileHostSessionStore(options.stateDir)
      : undefined);

  async function persistRecord(
    partial: Omit<HostSessionRecord, "createdAt" | "updatedAt"> & {
      createdAt?: string;
    },
  ): Promise<void> {
    if (!sessionStore) return;
    const prev = await sessionStore.load(partial.sessionKey);
    const now = new Date().toISOString();
    const record: HostSessionRecord = {
      sessionKey: partial.sessionKey,
      agentSessionId: partial.agentSessionId,
      agent: partial.agent,
      cwd: partial.cwd,
      ...(partial.modeId ? { modeId: partial.modeId } : prev?.modeId ? { modeId: prev.modeId } : {}),
      createdAt: partial.createdAt ?? prev?.createdAt ?? now,
      updatedAt: now,
    };
    await sessionStore.save(record);
    log.debug("session record saved", {
      sessionKey: record.sessionKey,
      agentSessionId: record.agentSessionId,
    });
  }

  function resolveKey(agentOrTacp: string): string {
    return agentIdToKey.get(agentOrTacp) ?? agentOrTacp;
  }

  function signalFor(sessionKey: string): AbortSignal {
    return live.get(sessionKey)?.turnAbort?.signal ?? new AbortController().signal;
  }

  async function handlePermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const sessionKey = resolveKey(params.sessionId);
    const toolCallId = params.toolCall?.toolCallId ?? "unknown";
    const signal = signalFor(sessionKey);
    if (!hooks.onPermissionRequest) {
      return decisionToPermissionResponse(
        params.options as never,
        { outcome: "reject_once" },
      ) as acp.RequestPermissionResponse;
    }
    try {
      const decision = await hooks.onPermissionRequest(
        { sessionId: sessionKey, toolCallId, raw: params },
        { signal },
      );
      return decisionToPermissionResponse(
        params.options as never,
        decision,
      ) as acp.RequestPermissionResponse;
    } catch {
      return { outcome: { outcome: "cancelled" } };
    }
  }

  async function handleElicitation(
    params: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    const sessionId =
      typeof (params as { sessionId?: string }).sessionId === "string"
        ? (params as { sessionId: string }).sessionId
        : "unknown";
    const sessionKey = resolveKey(sessionId);
    const signal = signalFor(sessionKey);
    if (!hooks.onElicitationRequest) {
      return { action: "decline" };
    }
    try {
      const decision = await hooks.onElicitationRequest(
        { sessionId: sessionKey, raw: params },
        { signal },
      );
      if (!decision) return { action: "decline" };
      if (decision.action === "accept") {
        return {
          action: "accept",
          content: decision.content ?? {},
        } as acp.CreateElicitationResponse;
      }
      return { action: decision.action };
    } catch {
      return { action: "cancel" };
    }
  }

  async function handleAskUserQuestion(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionId =
      typeof params.sessionId === "string" ? params.sessionId : "unknown";
    const sessionKey = resolveKey(sessionId);
    const signal = signalFor(sessionKey);
    if (!hooks.onAskUserQuestion) {
      return { outcome: "skip_interview" };
    }
    return hooks.onAskUserQuestion(
      { sessionId: sessionKey, raw: params },
      { signal },
    );
  }

  async function handleReadTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    const content = await readFile(params.path, "utf8");
    // Optional line range
    if (params.line != null || params.limit != null) {
      const lines = content.split("\n");
      const start = Math.max(0, (params.line ?? 1) - 1);
      const end =
        params.limit != null ? start + params.limit : lines.length;
      return { content: lines.slice(start, end).join("\n") };
    }
    return { content };
  }

  async function handleWriteTextFile(
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content, "utf8");
    return {};
  }

  async function handleCreateTerminal(
    params: acp.CreateTerminalRequest,
  ): Promise<acp.CreateTerminalResponse> {
    const id = randomUUID();
    const cwd = params.cwd ?? process.cwd();
    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env: { ...process.env, ...(params.env as NodeJS.ProcessEnv | undefined) },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rec: TerminalRec = {
      id,
      child,
      output: "",
      exitCode: null,
      exited: new Promise((resolve) => {
        child.on("close", (code) => {
          rec.exitCode = code ?? 0;
          resolve();
        });
      }),
    };
    child.stdout.on("data", (c: Buffer) => {
      rec.output += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      rec.output += c.toString("utf8");
    });
    if (params.outputByteLimit != null) {
      // soft cap later in output handler
    }
    terminals.set(id, rec);
    return { terminalId: id };
  }

  function handleTerminalOutput(
    params: acp.TerminalOutputRequest,
  ): acp.TerminalOutputResponse {
    const rec = terminals.get(params.terminalId);
    if (!rec) {
      return { output: "", truncated: false, exitStatus: null };
    }
    return {
      output: rec.output,
      truncated: false,
      exitStatus:
        rec.exitCode === null
          ? null
          : { exitCode: rec.exitCode, signal: null },
    };
  }

  async function handleWaitForTerminalExit(
    params: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> {
    const rec = terminals.get(params.terminalId);
    if (!rec) return { exitCode: 1, signal: null };
    await rec.exited;
    return { exitCode: rec.exitCode ?? 1, signal: null };
  }

  async function handleKillTerminal(
    params: acp.KillTerminalRequest,
  ): Promise<acp.KillTerminalResponse> {
    const rec = terminals.get(params.terminalId);
    rec?.child.kill("SIGTERM");
    return {};
  }

  async function handleReleaseTerminal(
    params: acp.ReleaseTerminalRequest,
  ): Promise<acp.ReleaseTerminalResponse> {
    const rec = terminals.get(params.terminalId);
    if (rec) {
      rec.child.kill("SIGTERM");
      terminals.delete(params.terminalId);
    }
    return {};
  }

  function buildClientApp(): acp.ClientApp {
    const askParser = (p: unknown) =>
      (p && typeof p === "object" ? p : {}) as Record<string, unknown>;

    return acp
      .client({ name: "tacp" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        handlePermission(ctx.params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) =>
        handleReadTextFile(ctx.params),
      )
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) =>
        handleWriteTextFile(ctx.params),
      )
      .onRequest(acp.methods.client.terminal.create, (ctx) =>
        handleCreateTerminal(ctx.params),
      )
      .onRequest(acp.methods.client.terminal.output, (ctx) =>
        handleTerminalOutput(ctx.params),
      )
      .onRequest(acp.methods.client.terminal.waitForExit, (ctx) =>
        handleWaitForTerminalExit(ctx.params),
      )
      .onRequest(acp.methods.client.terminal.kill, (ctx) =>
        handleKillTerminal(ctx.params),
      )
      .onRequest(acp.methods.client.terminal.release, (ctx) =>
        handleReleaseTerminal(ctx.params),
      )
      .onRequest(acp.methods.client.elicitation.create, (ctx) =>
        handleElicitation(ctx.params),
      )
      .onRequest("_x.ai/ask_user_question", askParser, (ctx) =>
        handleAskUserQuestion(ctx.params),
      )
      .onRequest("x.ai/ask_user_question", askParser, (ctx) =>
        handleAskUserQuestion(ctx.params),
      );
  }

  async function spawnSession(input: {
    sessionKey: string;
    agent: string;
    cwd: string;
  }): Promise<LiveSession> {
    const launch = resolveAgentLaunch(input.agent);
    log.info("spawn agent", {
      sessionKey: input.sessionKey,
      command: launch.command,
      args: launch.args,
      cwd: input.cwd,
    });

    const child = spawn(launch.command, launch.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    const stderrChunks: string[] = [];
    child.stderr.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      stderrChunks.push(s);
      if (stderrChunks.join("").length < 8000) {
        log.debug("agent stderr", { sessionKey: input.sessionKey, text: s.slice(0, 400) });
      }
    });

    child.on("exit", (code, signal) => {
      log.warn("agent process exit", {
        sessionKey: input.sessionKey,
        code,
        signal,
      });
      live.delete(input.sessionKey);
    });

    if (!child.stdin || !child.stdout) {
      throw new Error("agent spawn failed: missing stdio pipes");
    }

    const output = Writable.toWeb(child.stdin);
    const inputStream = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, inputStream);

    const app = buildClientApp();
    const connection = app.connect(stream);

    // Initialize
    const initResult = await connection.agent.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          elicitation: {
            form: {},
          },
        },
        clientInfo: {
          name: "tacp",
          version: "0.1.0",
        },
      },
    );
    log.info("acp initialized", {
      sessionKey: input.sessionKey,
      protocolVersion: initResult.protocolVersion,
    });

    const mcpServers =
      options.mcpEnabled === false
        ? []
        : buildTacpMcpServers({
            enabled: options.config.mcpEnabled !== false,
          });

    const mcpList = mcpServers as acp.McpServer[];
    const prior = sessionStore
      ? await sessionStore.load(input.sessionKey)
      : undefined;

    const supportsLoad =
      initResult.agentCapabilities?.loadSession === true;

    let session: acp.ActiveSession;
    let resumed = false;

    // Resume path: re-spawned process + session/load when agent advertises it.
    if (prior?.agentSessionId && supportsLoad) {
      try {
        log.info("session/load attempt", {
          sessionKey: input.sessionKey,
          agentSessionId: prior.agentSessionId,
        });
        const loadResp = await connection.agent.request(
          acp.methods.agent.session.load,
          {
            sessionId: prior.agentSessionId,
            cwd: input.cwd,
            mcpServers: mcpList,
          },
        );
        // attachSession is public at runtime; typed private on ClientContext.
        const agentCtx = connection.agent as acp.ClientContext & {
          attachSession(response: {
            sessionId: string;
            modes?: acp.SessionModeState | null;
            configOptions?: unknown;
            _meta?: Record<string, unknown> | null;
          }): acp.ActiveSession;
        };
        session = agentCtx.attachSession({
          sessionId: prior.agentSessionId,
          modes: loadResp?.modes ?? null,
          configOptions: loadResp?.configOptions ?? null,
          _meta: loadResp?._meta ?? null,
        });
        resumed = true;
        log.info("session/load ok", {
          sessionKey: input.sessionKey,
          agentSessionId: session.sessionId,
        });
      } catch (err) {
        log.warn("session/load failed; falling back to session/new", {
          sessionKey: input.sessionKey,
          agentSessionId: prior.agentSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!resumed) {
      session = await connection.agent
        .buildSession({
          cwd: input.cwd,
          mcpServers: mcpList,
        })
        .start();
      log.info("session/new ok", {
        sessionKey: input.sessionKey,
        agentSessionId: session.sessionId,
        mcp: mcpServers.map((s) => s.name),
        hadPrior: Boolean(prior),
      });
    }

    agentIdToKey.set(session.sessionId, input.sessionKey);
    agentIdToKey.set(input.sessionKey, input.sessionKey);

    // Prefer interactive mode when agent advertises modes
    const modes = session.modes;
    const available =
      modes?.availableModes?.map((m) => m.id) ??
      (modes as { available?: Array<{ id: string }> } | null | undefined)
        ?.available?.map((m) => m.id) ??
      [];
    let modeId: string | undefined = prior?.modeId;
    if (available.length > 0) {
      modeId = pickSessionModeId(available) ?? modeId;
      if (modeId) {
        try {
          await connection.agent.request(acp.methods.agent.session.setMode, {
            sessionId: session.sessionId,
            modeId,
          });
          log.info("setMode", { sessionKey: input.sessionKey, modeId });
        } catch (err) {
          log.warn("setMode failed", {
            sessionKey: input.sessionKey,
            modeId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    await persistRecord({
      sessionKey: input.sessionKey,
      agentSessionId: session.sessionId,
      agent: input.agent,
      cwd: input.cwd,
      ...(modeId ? { modeId } : {}),
      createdAt: prior?.createdAt,
    });

    const entry: LiveSession = {
      sessionKey: input.sessionKey,
      agent: input.agent,
      cwd: input.cwd,
      child,
      connection,
      session,
      currentModeId: modeId,
      availableModeIds: available,
      turnAbort: undefined,
    };
    live.set(input.sessionKey, entry);
    return entry;
  }

  return {
    setHooks(next) {
      hooks = { ...hooks, ...next };
    },

    async ensureSession(input) {
      const existing = live.get(input.sessionKey);
      if (existing) {
        return {
          sessionKey: input.sessionKey,
          agentSessionId: existing.session.sessionId,
          cwd: existing.cwd,
          agent: existing.agent,
          currentModeId: existing.currentModeId,
          availableModeIds: existing.availableModeIds,
        };
      }
      const entry = await spawnSession(input);
      return {
        sessionKey: input.sessionKey,
        agentSessionId: entry.session.sessionId,
        cwd: entry.cwd,
        agent: entry.agent,
        currentModeId: entry.currentModeId,
        availableModeIds: entry.availableModeIds,
      };
    },

    startTurn(input) {
      const entry = live.get(input.sessionKey);
      if (!entry) {
        throw new Error(`no live session for ${input.sessionKey}`);
      }

      const ac = new AbortController();
      entry.turnAbort = ac;
      if (input.signal) {
        if (input.signal.aborted) ac.abort();
        else {
          input.signal.addEventListener("abort", () => ac.abort(), {
            once: true,
          });
        }
      }

      const blocks: acp.ContentBlock[] = [
        { type: "text", text: input.text },
      ];
      for (const a of input.attachments ?? []) {
        if (a.mediaType.startsWith("image/")) {
          blocks.push({
            type: "image",
            mimeType: a.mediaType,
            data: a.data,
          } as acp.ContentBlock);
        } else if (a.mediaType.startsWith("audio/")) {
          blocks.push({
            type: "audio",
            mimeType: a.mediaType,
            data: a.data,
          } as acp.ContentBlock);
        }
      }

      let resolveResult!: (r: {
        status: string;
        stopReason?: string;
        error?: { message?: string };
      }) => void;
      const result = new Promise<{
        status: string;
        stopReason?: string;
        error?: { message?: string };
      }>((resolve) => {
        resolveResult = resolve;
      });

      const events = (async function* (): AsyncGenerator<HostTurnEvent> {
        try {
          // Fire prompt (promise resolves with final PromptResponse; also queued as stop)
          void entry.session.prompt(blocks).catch((err) => {
            log.error("prompt failed", {
              sessionKey: input.sessionKey,
              error: err instanceof Error ? err.message : String(err),
            });
          });

          for (;;) {
            if (ac.signal.aborted) {
              try {
                await entry.connection.agent.notify(
                  acp.methods.agent.session.cancel,
                  { sessionId: entry.session.sessionId },
                );
              } catch {
                /* best effort */
              }
              yield { type: "done", stopReason: "cancelled" };
              resolveResult({ status: "cancelled", stopReason: "cancelled" });
              return;
            }

            const message = await entry.session.nextUpdate();
            if (message.kind === "stop") {
              const stopReason = String(message.stopReason ?? "end_turn");
              yield { type: "done", stopReason };
              // Heartbeat durable record so last-used survives restarts.
              void persistRecord({
                sessionKey: entry.sessionKey,
                agentSessionId: entry.session.sessionId,
                agent: entry.agent,
                cwd: entry.cwd,
              });
              resolveResult({
                status:
                  stopReason === "cancelled" ? "cancelled" : "completed",
                stopReason,
              });
              return;
            }

            const update = message.update as {
              sessionUpdate?: string;
              content?: unknown;
              toolCallId?: string;
              title?: string;
              status?: string;
              rawInput?: unknown;
              kind?: string;
              locations?: unknown;
              rawOutput?: unknown;
              currentModeId?: string;
              modeId?: string;
            };

            switch (update.sessionUpdate) {
              case "agent_message_chunk": {
                const text = contentText(update.content);
                if (text) {
                  yield { type: "text_delta", text, stream: "output" };
                }
                break;
              }
              case "agent_thought_chunk": {
                const text = contentText(update.content);
                if (text) {
                  yield { type: "text_delta", text, stream: "thought" };
                }
                break;
              }
              case "tool_call":
              case "tool_call_update": {
                yield {
                  type: "tool_call",
                  toolCallId: update.toolCallId,
                  title: update.title,
                  status: update.status,
                  rawInput: update.rawInput,
                  kind: update.kind,
                  locations: update.locations,
                  rawOutput: update.rawOutput,
                  tag: update.sessionUpdate,
                };
                break;
              }
              case "current_mode_update": {
                const mid =
                  (update as { currentModeId?: string; modeId?: string })
                    .currentModeId ??
                  (update as { modeId?: string }).modeId;
                if (typeof mid === "string" && mid) {
                  entry.currentModeId = mid;
                  void persistRecord({
                    sessionKey: entry.sessionKey,
                    agentSessionId: entry.session.sessionId,
                    agent: entry.agent,
                    cwd: entry.cwd,
                    modeId: mid,
                  });
                }
                break;
              }
              default:
                break;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          yield { type: "error", message };
          resolveResult({
            status: "failed",
            error: { message },
          });
        } finally {
          if (entry.turnAbort === ac) entry.turnAbort = undefined;
        }
      })();

      return {
        events,
        result,
        cancel: async () => {
          ac.abort();
          try {
            await entry.connection.agent.notify(
              acp.methods.agent.session.cancel,
              { sessionId: entry.session.sessionId },
            );
          } catch {
            /* ignore */
          }
        },
      };
    },

    async cancel(sessionKey, _reason) {
      const entry = live.get(sessionKey);
      if (!entry) return;
      entry.turnAbort?.abort();
      try {
        await entry.connection.agent.notify(
          acp.methods.agent.session.cancel,
          { sessionId: entry.session.sessionId },
        );
      } catch {
        /* ignore */
      }
    },

    async setMode(sessionKey, modeId) {
      const entry = live.get(sessionKey);
      if (!entry) {
        throw new Error(`no live session for ${sessionKey}`);
      }
      await entry.connection.agent.request(acp.methods.agent.session.setMode, {
        sessionId: entry.session.sessionId,
        modeId,
      });
      entry.currentModeId = modeId;
      await persistRecord({
        sessionKey: entry.sessionKey,
        agentSessionId: entry.session.sessionId,
        agent: entry.agent,
        cwd: entry.cwd,
        modeId,
      });
      log.info("setMode ok", { sessionKey, modeId });
      return {
        currentModeId: entry.currentModeId,
        availableModeIds: entry.availableModeIds,
      };
    },

    getModeState(sessionKey) {
      const entry = live.get(sessionKey);
      if (!entry) return undefined;
      return {
        currentModeId: entry.currentModeId,
        availableModeIds: entry.availableModeIds,
      };
    },

    getAvailableModes(sessionKey) {
      const entry = live.get(sessionKey);
      if (!entry) return [];
      if (entry.availableModeIds.length > 0) return [...entry.availableModeIds];
      const modes = entry.session.modes;
      return (
        modes?.availableModes?.map((m) => m.id) ??
        (modes as { available?: Array<{ id: string }> } | null | undefined)
          ?.available?.map((m) => m.id) ??
        []
      );
    },

    async dispose() {
      for (const [, entry] of live) {
        try {
          entry.session.dispose();
          entry.connection.close();
        } catch {
          /* ignore */
        }
        entry.child.kill("SIGTERM");
      }
      live.clear();
      for (const t of terminals.values()) {
        t.child.kill("SIGTERM");
      }
      terminals.clear();
    },
  };
}
