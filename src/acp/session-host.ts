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
import {
  applyModelToLaunch,
  getCannedModelsForAgent,
} from "./agent-models";
import { decisionToPermissionResponse } from "./permission-map";
import { buildSessionMcpServers } from "../mcp/repo-mcp";
import type { TacpConfig } from "../env/types";
import { pickSessionModeId } from "./session-mode";
import {
  findModelConfigOption,
  modelsStateToConfigOptions,
  normalizeConfigOptions,
  type SessionConfigOptionView,
} from "./session-config";
import { TerminalManager } from "./terminal-manager";
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
  configOptions?: SessionConfigOptionView[] | undefined;
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
  /** ACP configOptions (model select, etc.) */
  configOptions: SessionConfigOptionView[];
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
  getConfigOptions(sessionKey: string): SessionConfigOptionView[];
  setConfigOption(
    sessionKey: string,
    configId: string,
    value: string | boolean,
  ): Promise<SessionConfigOptionView[]>;
  /** Kill live process for sessionKey (used before agent binary switch). */
  disposeSession(sessionKey: string): Promise<void>;
  setHooks(hooks: SessionHostHooks): void;
  dispose(): Promise<void>;
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
  const sessionStore: HostSessionStore | undefined =
    options.sessionStore ??
    (options.stateDir
      ? createFileHostSessionStore(options.stateDir)
      : undefined);
  /** Shared ACP client terminal/* manager (acpx-grade). */
  const terminals = new TerminalManager({
    cwd: process.cwd(),
    log,
  });
  /**
   * Preferred spawn-time model id per session (canned / non-ACP agents).
   * Survives process respawn within this host lifetime.
   */
  const preferredModelBySession = new Map<string, string>();

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
    return terminals.createTerminal(params);
  }

  async function handleTerminalOutput(
    params: acp.TerminalOutputRequest,
  ): Promise<acp.TerminalOutputResponse> {
    return terminals.terminalOutput(params);
  }

  async function handleWaitForTerminalExit(
    params: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> {
    return terminals.waitForTerminalExit(params);
  }

  async function handleKillTerminal(
    params: acp.KillTerminalRequest,
  ): Promise<acp.KillTerminalResponse> {
    return terminals.killTerminal(params);
  }

  async function handleReleaseTerminal(
    params: acp.ReleaseTerminalRequest,
  ): Promise<acp.ReleaseTerminalResponse> {
    return terminals.releaseTerminal(params);
  }

  function buildClientApp(sessionKey: string): acp.ClientApp {
    const askParser = (p: unknown) =>
      (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const modelsParser = (p: unknown) =>
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
      )
      // Grok Build pushes model catalog here (not only on session/new).
      // https://github.com/xai-org/grok-build — SessionModelState
      .onNotification("_x.ai/models/update", modelsParser, (ctx) => {
        const opts = modelsStateToConfigOptions(ctx.params);
        if (opts.length === 0) return;
        const entry = live.get(sessionKey);
        if (entry) {
          entry.configOptions = opts;
          const cur = opts[0]?.currentValue;
          if (typeof cur === "string") {
            preferredModelBySession.set(sessionKey, cur);
          }
          log.info("models updated via _x.ai/models/update", {
            sessionKey,
            count: opts[0]?.options.length ?? 0,
            current: cur ?? null,
          });
        }
      });
  }

  function syntheticCannedConfig(
    agent: string,
    sessionKey: string,
  ): SessionConfigOptionView[] {
    const canned = getCannedModelsForAgent(agent);
    if (canned.length === 0) return [];
    const current =
      preferredModelBySession.get(sessionKey) ?? canned[0]!.value;
    return [
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: current,
        options: canned.map((m) => ({
          value: m.value,
          name: m.name,
          ...(m.description ? { description: m.description } : {}),
        })),
      },
    ];
  }

  async function spawnSession(input: {
    sessionKey: string;
    agent: string;
    cwd: string;
  }): Promise<LiveSession> {
    const baseLaunch = resolveAgentLaunch(input.agent);
    const preferredModel = preferredModelBySession.get(input.sessionKey);
    const launch = applyModelToLaunch(
      input.agent,
      baseLaunch,
      preferredModel,
    );
    log.info("spawn agent", {
      sessionKey: input.sessionKey,
      command: launch.command,
      args: launch.args,
      cwd: input.cwd,
      model: preferredModel ?? null,
    });

    const childEnv = {
      ...process.env,
      ...(launch.env ?? {}),
    };

    const child = spawn(launch.command, launch.args, {
      cwd: input.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    const stderrChunks: string[] = [];
    child.stderr.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      stderrChunks.push(s);
      if (stderrChunks.join("").length < 8000) {
        log.debug("agent stderr", {
          sessionKey: input.sessionKey,
          text: s.slice(0, 400),
        });
      }
    });

    let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null =
      null;
    child.on("exit", (code, signal) => {
      earlyExit = { code, signal };
      log.warn("agent process exit", {
        sessionKey: input.sessionKey,
        code,
        signal,
        stderr: stderrChunks.join("").slice(0, 500),
      });
      live.delete(input.sessionKey);
    });

    if (!child.stdin || !child.stdout) {
      throw new Error("agent spawn failed: missing stdio pipes");
    }

    // Fail fast if process dies before initialize (bad command / missing adapter)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => resolve(), 80);
      child.once("exit", (code, signal) => {
        clearTimeout(t);
        const errText = stderrChunks.join("").trim().slice(0, 800);
        reject(
          new Error(
            `agent process exited immediately (code=${code}, signal=${signal})` +
              (errText ? `:\n${errText}` : "") +
              `\ncommand: ${launch.command} ${launch.args.join(" ")}`,
          ),
        );
      });
      child.once("error", (err) => {
        clearTimeout(t);
        reject(
          new Error(
            `agent spawn error: ${err.message}\ncommand: ${launch.command} ${launch.args.join(" ")}`,
          ),
        );
      });
    });
    if (earlyExit) {
      const errText = stderrChunks.join("").trim().slice(0, 800);
      throw new Error(
        `agent process exited immediately (code=${earlyExit.code})` +
          (errText ? `:\n${errText}` : "") +
          `\ncommand: ${launch.command} ${launch.args.join(" ")}`,
      );
    }

    const output = Writable.toWeb(child.stdin);
    const inputStream = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, inputStream);

    const app = buildClientApp(input.sessionKey);
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

    // sessionKey is `repo/name` — use repo segment for OAuth token path.
    const repoKeyFromSession = input.sessionKey.includes("/")
      ? input.sessionKey.slice(0, input.sessionKey.indexOf("/"))
      : input.sessionKey;

    const mcpList: acp.McpServer[] =
      options.mcpEnabled === false
        ? []
        : await buildSessionMcpServers({
            cwd: input.cwd,
            enabled: options.config.mcpEnabled !== false,
            sessionKey: input.sessionKey,
            repoKey: repoKeyFromSession,
            ...(options.stateDir !== undefined
              ? { stateDir: options.stateDir, oauthStateDir: options.stateDir }
              : {}),
            log,
          });
    const prior = sessionStore
      ? await sessionStore.load(input.sessionKey)
      : undefined;

    const supportsLoad =
      initResult.agentCapabilities?.loadSession === true;

    let session!: acp.ActiveSession;
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
        const agentCtx = connection.agent as unknown as {
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
        mcp: mcpList.map((s) => s.name),
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

    // Model sources (priority):
    // 1) Grok-style session.models / SessionModelState (session/set_model)
    // 2) configOptions select with category/id model
    // 3) canned spawn-time models for this agent
    const sessionModels =
      (session as { models?: unknown }).models ??
      (session as { _meta?: { models?: unknown; modelState?: unknown } })._meta
        ?.models ??
      (session as { _meta?: { modelState?: unknown } })._meta?.modelState;
    let configOptions = modelsStateToConfigOptions(sessionModels);
    if (!findModelConfigOption(configOptions)) {
      const configRaw =
        (session as { configOptions?: unknown }).configOptions ??
        (session as { _meta?: { configOptions?: unknown } })._meta
          ?.configOptions;
      configOptions = normalizeConfigOptions(configRaw);
    }
    if (!findModelConfigOption(configOptions)) {
      configOptions = syntheticCannedConfig(input.agent, input.sessionKey);
    } else {
      const cur = findModelConfigOption(configOptions)?.currentValue;
      if (typeof cur === "string") {
        preferredModelBySession.set(input.sessionKey, cur);
      }
    }
    log.info("session models/config", {
      sessionKey: input.sessionKey,
      modelCount: findModelConfigOption(configOptions)?.options.length ?? 0,
      current: findModelConfigOption(configOptions)?.currentValue ?? null,
      source: findModelConfigOption(configOptions)
        ? modelsStateToConfigOptions(sessionModels).length
          ? "session.models"
          : "configOptions-or-canned"
        : "none",
    });

    await persistRecord({
      sessionKey: input.sessionKey,
      agentSessionId: session.sessionId,
      agent: input.agent,
      cwd: input.cwd,
      ...(modeId ? { modeId } : {}),
      ...(prior?.createdAt ? { createdAt: prior.createdAt } : {}),
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
      configOptions,
      turnAbort: undefined,
    };
    live.set(input.sessionKey, entry);
    return entry;
  }

  async function killLiveSession(sessionKey: string): Promise<void> {
    const entry = live.get(sessionKey);
    if (!entry) return;
    entry.turnAbort?.abort();
    try {
      await entry.connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: entry.session.sessionId,
      });
    } catch {
      /* */
    }
    try {
      entry.child.kill("SIGTERM");
    } catch {
      /* */
    }
    agentIdToKey.delete(entry.session.sessionId);
    agentIdToKey.delete(sessionKey);
    live.delete(sessionKey);
    log.info("disposed live session", { sessionKey, agent: entry.agent });
  }

  return {
    setHooks(next) {
      hooks = { ...hooks, ...next };
    },

    async ensureSession(input) {
      const existing = live.get(input.sessionKey);
      if (existing) {
        // Agent or cwd change → kill and respawn (e.g. /agent switch).
        if (
          existing.agent !== input.agent ||
          existing.cwd !== input.cwd
        ) {
          log.info("ensureSession: agent/cwd changed; respawning", {
            sessionKey: input.sessionKey,
            fromAgent: existing.agent,
            toAgent: input.agent,
          });
          // Model preference is per agent family — clear on binary switch.
          if (existing.agent !== input.agent) {
            preferredModelBySession.delete(input.sessionKey);
          }
          await killLiveSession(input.sessionKey);
        } else {
          return {
            sessionKey: input.sessionKey,
            agentSessionId: existing.session.sessionId,
            cwd: existing.cwd,
            agent: existing.agent,
            currentModeId: existing.currentModeId,
            availableModeIds: existing.availableModeIds,
            configOptions: existing.configOptions,
          };
        }
      }
      const entry = await spawnSession(input);
      return {
        sessionKey: input.sessionKey,
        agentSessionId: entry.session.sessionId,
        cwd: entry.cwd,
        agent: entry.agent,
        currentModeId: entry.currentModeId,
        availableModeIds: entry.availableModeIds,
        configOptions: entry.configOptions,
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

    getConfigOptions(sessionKey) {
      const entry = live.get(sessionKey);
      if (!entry) {
        // No live session — still return canned list if we know agent from store later.
        return [];
      }
      // Prefer live ACP options if they include a model select.
      const raw = (entry.session as { configOptions?: unknown }).configOptions;
      const fromAgent = normalizeConfigOptions(raw);
      if (findModelConfigOption(fromAgent)) {
        entry.configOptions = fromAgent;
        return [...entry.configOptions];
      }
      // Canned fallback (Grok etc.)
      if (!findModelConfigOption(entry.configOptions)) {
        entry.configOptions = syntheticCannedConfig(
          entry.agent,
          sessionKey,
        );
      } else {
        // Keep currentValue in sync with preferred spawn model
        const m = findModelConfigOption(entry.configOptions);
        const pref = preferredModelBySession.get(sessionKey);
        if (m && pref) m.currentValue = pref;
      }
      return [...entry.configOptions];
    },

    async setConfigOption(sessionKey, configId, value) {
      const entry = live.get(sessionKey);
      if (!entry) {
        throw new Error(`no live session for ${sessionKey}`);
      }

      // Detect whether this is a real ACP model option or our canned fallback.
      const fromAgent = normalizeConfigOptions(
        (entry.session as { configOptions?: unknown }).configOptions,
      );
      const acpModel = findModelConfigOption(fromAgent);
      const useCanned =
        configId === "model" &&
        typeof value === "string" &&
        !acpModel;

      if (useCanned) {
        const canned = getCannedModelsForAgent(entry.agent);
        if (!canned.some((m) => m.value === value)) {
          throw new Error(
            `unknown model \`${value}\` for agent \`${entry.agent}\`. ` +
              `Options: ${canned.map((m) => m.value).join(", ") || "(none)"}`,
          );
        }
        preferredModelBySession.set(sessionKey, value);
        log.info("setConfigOption canned model → respawn", {
          sessionKey,
          agent: entry.agent,
          model: value,
        });
        const agent = entry.agent;
        const cwd = entry.cwd;
        await killLiveSession(sessionKey);
        const next = await spawnSession({ sessionKey, agent, cwd });
        return [...next.configOptions];
      }

      // Grok Build uses dedicated session/set_model (not set_config_option).
      // https://github.com/xai-org/grok-build — SetSessionModelRequest
      if (typeof value === "string" && (configId === "model" || /model/i.test(configId))) {
        try {
          const resp = await entry.connection.agent.request(
            "session/set_model" as never,
            {
              sessionId: entry.session.sessionId,
              modelId: value,
            } as never,
          );
          // Response may include updated model state
          const respModels =
            (resp as { models?: unknown })?.models ??
            (resp as { _meta?: { modelState?: unknown } })?._meta?.modelState;
          const fromResp = modelsStateToConfigOptions(respModels);
          if (fromResp.length > 0) {
            entry.configOptions = fromResp;
          } else {
            const hit = findModelConfigOption(entry.configOptions);
            if (hit) hit.currentValue = value;
          }
          preferredModelBySession.set(sessionKey, value);
          log.info("set_model ok (Grok/ACP session model)", {
            sessionKey,
            modelId: value,
          });
          return [...entry.configOptions];
        } catch (setModelErr) {
          log.debug("session/set_model failed; trying set_config_option", {
            sessionKey,
            error:
              setModelErr instanceof Error
                ? setModelErr.message
                : String(setModelErr),
          });
        }
      }

      // Native ACP configOptions path
      const params =
        typeof value === "boolean"
          ? {
              sessionId: entry.session.sessionId,
              configId,
              type: "boolean" as const,
              value,
            }
          : {
              sessionId: entry.session.sessionId,
              configId,
              value,
            };
      try {
        const resp = await entry.connection.agent.request(
          acp.methods.agent.session.setConfigOption,
          params as never,
        );
        const nextRaw =
          (resp as { configOptions?: unknown })?.configOptions ??
          (entry.session as { configOptions?: unknown }).configOptions;
        entry.configOptions = normalizeConfigOptions(nextRaw);
        const hit = entry.configOptions.find((o) => o.id === configId);
        if (hit) hit.currentValue = value;
        if (configId === "model" && typeof value === "string") {
          preferredModelBySession.set(sessionKey, value);
        }
        log.info("setConfigOption ok (ACP)", {
          sessionKey,
          configId,
          value: String(value),
        });
        return [...entry.configOptions];
      } catch (err) {
        // Fall back to canned respawn if ACP rejects both paths
        if (
          typeof value === "string" &&
          getCannedModelsForAgent(entry.agent).length
        ) {
          preferredModelBySession.set(sessionKey, value);
          const agent = entry.agent;
          const cwd = entry.cwd;
          await killLiveSession(sessionKey);
          const next = await spawnSession({ sessionKey, agent, cwd });
          log.warn("set model ACP failed; used canned respawn", {
            sessionKey,
            error: err instanceof Error ? err.message : String(err),
            model: value,
          });
          return [...next.configOptions];
        }
        throw err;
      }
    },

    async disposeSession(sessionKey) {
      await killLiveSession(sessionKey);
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
      await terminals.shutdown();
    },
  };
}
