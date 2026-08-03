/**
 * Thin ACP host: spawn agent stdio + official @agentclientprotocol/sdk client.
 * Thin ACP session host for acpbot's AgentsPort.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
import { resolveAgentLaunchForSpawn } from "./agent-launch";
import { decisionToPermissionResponse } from "./permission-map";
import { buildSessionMcpServers } from "../mcp/repo-mcp";
import type { AcpbotConfig } from "../env/types";
import {
  extractSessionModes,
  isEffortLikeModeId,
  pickModeForPermissionPolicy,
  pickSessionModeId,
} from "./session-mode";
import {
  findEffortConfigOption,
  findModeConfigOption,
  findModelConfigOption,
  modelsStateToConfigOptions,
  normalizeConfigOptions,
  sessionConfigEffortToConfigOptions,
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
  config: AcpbotConfig;
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
  /** Tool-permission policy for this live slot */
  permissionMode: "ask" | "bypass";
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
    /**
     * Tool-permission policy for this slot.
     * bypass → Grok yoloMode / spawn --always-approve + host auto-allow.
     */
    permissionMode?: "ask" | "bypass";
    /**
     * Kill live agent and respawn so MCP servers are rebuilt (fresh OAuth
     * Bearer headers after `/mcp auth`).
     */
    forceRespawn?: boolean;
  }): Promise<HostSession>;
  startTurn(input: {
    sessionKey: string;
    text: string;
    attachments?: Array<{ mediaType: string; data: string }>;
    signal?: AbortSignal;
  }): HostTurn;
  cancel(sessionKey: string, reason?: string): Promise<void>;
  setMode(sessionKey: string, modeId: string): Promise<HostModeState>;
  /**
   * Current mode state. In-process host reads the live entry; acp-host client
   * always RPCs `get_mode` so the worker never serves a stale cache.
   */
  getModeState(sessionKey: string): Promise<HostModeState | undefined>;
  getAvailableModes(sessionKey: string): Promise<string[]>;
  /**
   * Model/config options. In-process host reads the live entry (including late
   * `_x.ai/models/update`); acp-host client always RPCs `get_config`.
   */
  getConfigOptions(sessionKey: string): Promise<SessionConfigOptionView[]>;
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

function isEffortConfigId(configId: string): boolean {
  return (
    configId === "effort" ||
    /effort|thought_level/i.test(configId)
  );
}

/** Populate mode state from configOptions mode select (OpenCode). */
function syncModesFromConfigOptions(entry: {
  currentModeId: string | undefined;
  availableModeIds: string[];
  configOptions: SessionConfigOptionView[];
}): void {
  if (entry.availableModeIds.length > 0) {
    const modeCfg = findModeConfigOption(entry.configOptions);
    if (modeCfg && entry.currentModeId) {
      modeCfg.currentValue = entry.currentModeId;
    }
    return;
  }
  const view = extractSessionModes({ configOptions: entry.configOptions });
  if (view.availableModeIds.length === 0) return;
  entry.availableModeIds = view.availableModeIds;
  if (!entry.currentModeId && view.currentModeId) {
    entry.currentModeId = view.currentModeId;
  }
}

/**
 * ActiveSession only exposes modes/meta getters; configOptions + extension
 * fields live on `newSessionResponse` (the validated session/new|load body).
 */
function sessionNewPayload(session: acp.ActiveSession): {
  configOptions?: unknown;
  models?: unknown;
  meta?: Record<string, unknown> | null;
} {
  const resp = (
    session as {
      newSessionResponse?: {
        configOptions?: unknown;
        models?: unknown;
        _meta?: Record<string, unknown> | null;
      };
    }
  ).newSessionResponse;
  const meta =
    session.meta ??
    resp?._meta ??
    (session as { _meta?: Record<string, unknown> | null })._meta ??
    null;
  return {
    configOptions:
      resp?.configOptions ??
      (session as { configOptions?: unknown }).configOptions,
    models:
      resp?.models ??
      (session as { models?: unknown }).models ??
      meta?.models ??
      meta?.modelState,
    meta,
  };
}

export function createSessionHost(options: SessionHostOptions): SessionHost {
  const log = (options.log ?? silentLogger()).child("acp-host");
  const live = new Map<string, LiveSession>();
  /** agent session id → acpbot sessionKey */
  const agentIdToKey = new Map<string, string>();
  let hooks: SessionHostHooks = { ...options.hooks };
  const sessionStore: HostSessionStore | undefined =
    options.sessionStore ??
    (options.stateDir
      ? createFileHostSessionStore(options.stateDir)
      : undefined);
  /** Shared ACP client terminal/* manager. */
  const terminals = new TerminalManager({
    cwd: process.cwd(),
    log,
  });
  /**
   * Model catalog notifications can arrive before live.set during session/new.
   * Buffer by acpbot sessionKey until the LiveSession entry exists.
   */
  const pendingModelConfig = new Map<string, SessionConfigOptionView[]>();

  async function persistRecord(
    partial: Omit<HostSessionRecord, "createdAt" | "updatedAt"> & {
      createdAt?: string;
      modelId?: string;
    },
  ): Promise<void> {
    if (!sessionStore) return;
    const prev = await sessionStore.load(partial.sessionKey);
    const now = new Date().toISOString();
    const modeId = partial.modeId ?? prev?.modeId;
    const modelId = partial.modelId ?? prev?.modelId;
    const record: HostSessionRecord = {
      sessionKey: partial.sessionKey,
      agentSessionId: partial.agentSessionId,
      agent: partial.agent,
      cwd: partial.cwd,
      ...(modeId ? { modeId } : {}),
      ...(modelId ? { modelId } : {}),
      createdAt: partial.createdAt ?? prev?.createdAt ?? now,
      updatedAt: now,
    };
    await sessionStore.save(record);
    log.debug("session record saved", {
      sessionKey: record.sessionKey,
      agentSessionId: record.agentSessionId,
    });
  }

  function modelIdFromConfig(
    opts: SessionConfigOptionView[],
  ): string | undefined {
    const m = findModelConfigOption(opts);
    if (!m || m.currentValue == null) return undefined;
    return String(m.currentValue);
  }

  /** Seed a single-current model select when the agent has not re-advertised a catalog. */
  function seedModelConfigFromId(modelId: string): SessionConfigOptionView[] {
    return [
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: modelId,
        options: [{ value: modelId, name: modelId }],
      },
    ];
  }

  /**
   * Grok often pushes `_x.ai/models/update` slightly after session/new (or load).
   * Wait briefly so ensure/status can observe the catalog without a full turn.
   */
  async function waitForLateModels(
    sessionKey: string,
    entry: LiveSession,
    timeoutMs = 2000,
  ): Promise<void> {
    if (findModelConfigOption(entry.configOptions)) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      if (findModelConfigOption(entry.configOptions)) return;
      const buffered = pendingModelConfig.get(sessionKey);
      if (buffered && findModelConfigOption(buffered)) {
        entry.configOptions = buffered;
        pendingModelConfig.delete(sessionKey);
        return;
      }
    }
  }

  function resolveKey(agentOrId: string): string {
    return agentIdToKey.get(agentOrId) ?? agentOrId;
  }

  function signalFor(sessionKey: string): AbortSignal {
    return live.get(sessionKey)?.turnAbort?.signal ?? new AbortController().signal;
  }

  /**
   * Coalesce concurrent identical permission asks (same kind+title) and briefly
   * cache allows so agent requestPermission + host terminal/fs gates do not
   * each open a second Telegram keyboard for the same action.
   */
  const inflightPermissions = new Map<
    string,
    Promise<PermissionDecision | undefined>
  >();
  /** Fingerprint → expiry (ms) for a recent allow_once / allow_always. */
  const recentAllows = new Map<string, number>();
  const RECENT_ALLOW_MS = 20_000;

  function permissionFingerprint(
    sessionKey: string,
    kind: string,
    title: string,
  ): string {
    return `${sessionKey}\0${(kind || "").toLowerCase()}\0${title.trim()}`;
  }

  function wasRecentlyAllowed(fp: string): boolean {
    const until = recentAllows.get(fp);
    if (until == null) return false;
    if (Date.now() > until) {
      recentAllows.delete(fp);
      return false;
    }
    return true;
  }

  function markRecentlyAllowed(fp: string): void {
    recentAllows.set(fp, Date.now() + RECENT_ALLOW_MS);
  }

  async function askSharedPermission(input: {
    sessionKey: string;
    fingerprint: string;
    toolCallId: string;
    raw: unknown;
  }): Promise<PermissionDecision | undefined> {
    if (wasRecentlyAllowed(input.fingerprint)) {
      log.info("permission auto-allow (recent identical grant)", {
        sessionKey: input.sessionKey,
        toolCallId: input.toolCallId,
      });
      return { outcome: "allow_once" };
    }

    const existing = inflightPermissions.get(input.fingerprint);
    if (existing) {
      log.info("permission coalesced with in-flight ask", {
        sessionKey: input.sessionKey,
        toolCallId: input.toolCallId,
      });
      return existing;
    }

    if (!hooks.onPermissionRequest) {
      return { outcome: "reject_once" };
    }

    const work = (async () => {
      const liveEntry = live.get(input.sessionKey);
      if (liveEntry?.permissionMode === "bypass") {
        return { outcome: "allow_always" as const };
      }
      const decision = await hooks.onPermissionRequest!(
        {
          sessionId: input.sessionKey,
          toolCallId: input.toolCallId,
          raw: input.raw,
        },
        { signal: signalFor(input.sessionKey) },
      );
      if (
        decision?.outcome === "allow_once" ||
        decision?.outcome === "allow_always"
      ) {
        markRecentlyAllowed(input.fingerprint);
      }
      if (decision?.outcome === "allow_always" && liveEntry) {
        liveEntry.permissionMode = "bypass";
        log.info("permission allow_always → session bypass", {
          sessionKey: input.sessionKey,
        });
      }
      return decision;
    })();

    inflightPermissions.set(input.fingerprint, work);
    try {
      return await work;
    } finally {
      inflightPermissions.delete(input.fingerprint);
    }
  }

  /**
   * Grok (and some agents) run shell/write via client terminal/* and fs/*
   * without calling session/request_permission. In ask mode we synthesize
   * a permission prompt so Telegram still gates those host capabilities.
   */
  async function requireHostSidePermission(input: {
    sessionId: string;
    title: string;
    kind: string;
    rawInput?: unknown;
  }): Promise<void> {
    const sessionKey = resolveKey(input.sessionId);
    const entry = live.get(sessionKey);
    if (!entry || entry.permissionMode === "bypass") return;

    if (!hooks.onPermissionRequest) {
      throw new Error(
        `Permission required for ${input.title} but no permission handler is wired`,
      );
    }

    const toolCallId = `host-${input.kind}-${Date.now().toString(36)}`;
    const raw = {
      sessionId: sessionKey,
      toolCallId,
      toolCall: {
        toolCallId,
        title: input.title,
        kind: input.kind,
        ...(input.rawInput !== undefined
          ? { rawInput: input.rawInput }
          : {}),
      },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        {
          optionId: "allow_always",
          name: "Allow always (this session)",
          kind: "allow_always",
        },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    };

    const fp = permissionFingerprint(sessionKey, input.kind, input.title);
    log.info("host-side permission ask", {
      sessionKey,
      kind: input.kind,
      title: input.title.slice(0, 120),
    });

    const decision = await askSharedPermission({
      sessionKey,
      fingerprint: fp,
      toolCallId,
      raw,
    });

    if (
      !decision ||
      decision.outcome === "cancel" ||
      decision.outcome === "reject_once" ||
      decision.outcome === "reject_always"
    ) {
      throw new Error(
        `Permission denied (${decision?.outcome ?? "none"}) for ${input.title}`,
      );
    }
  }

  async function handlePermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const sessionKey = resolveKey(params.sessionId);
    const toolCallId = params.toolCall?.toolCallId ?? "unknown";
    const entry = live.get(sessionKey);
    if (entry?.permissionMode === "bypass") {
      return decisionToPermissionResponse(params.options as never, {
        outcome: "allow_always",
      }) as acp.RequestPermissionResponse;
    }
    if (!hooks.onPermissionRequest) {
      return decisionToPermissionResponse(
        params.options as never,
        { outcome: "reject_once" },
      ) as acp.RequestPermissionResponse;
    }
    try {
      const title =
        typeof params.toolCall?.title === "string"
          ? params.toolCall.title
          : toolCallId;
      const kind =
        typeof params.toolCall?.kind === "string" ? params.toolCall.kind : "";
      const fp = permissionFingerprint(sessionKey, kind, title);
      const decision = await askSharedPermission({
        sessionKey,
        fingerprint: fp,
        toolCallId,
        raw: params,
      });
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
    // Reads are allowed without a prompt (common for agents). Writes + shell ask.
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
    await requireHostSidePermission({
      sessionId: params.sessionId,
      title: `Write file: ${params.path}`,
      kind: "edit",
      rawInput: {
        path: params.path,
        bytes: Buffer.byteLength(params.content, "utf8"),
      },
    });
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content, "utf8");
    return {};
  }

  async function handleCreateTerminal(
    params: acp.CreateTerminalRequest,
  ): Promise<acp.CreateTerminalResponse> {
    const cmd = [params.command, ...(params.args ?? [])].join(" ").trim();
    await requireHostSidePermission({
      sessionId: params.sessionId,
      title: `Run command: ${cmd || params.command}`,
      kind: "execute",
      rawInput: {
        command: params.command,
        args: params.args,
        cwd: params.cwd,
      },
    });
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
      .client({ name: "acpbot" })
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
          const mid = modelIdFromConfig(opts);
          if (mid) {
            void persistRecord({
              sessionKey: entry.sessionKey,
              agentSessionId: entry.session.sessionId,
              agent: entry.agent,
              cwd: entry.cwd,
              ...(entry.currentModeId ? { modeId: entry.currentModeId } : {}),
              modelId: mid,
            });
          }
        } else {
          pendingModelConfig.set(sessionKey, opts);
        }
        log.info("models updated via _x.ai/models/update", {
          sessionKey,
          count: opts[0]?.options.length ?? 0,
          current: opts[0]?.currentValue ?? null,
          buffered: !entry,
        });
      });
  }

  async function spawnSession(input: {
    sessionKey: string;
    agent: string;
    cwd: string;
    permissionMode?: "ask" | "bypass";
  }): Promise<LiveSession> {
    const alwaysApprove = input.permissionMode === "bypass";
    const launch = resolveAgentLaunchForSpawn(
      input.agent,
      process.env,
      undefined,
      { alwaysApprove },
    );
    log.info("spawn agent", {
      sessionKey: input.sessionKey,
      command: launch.command,
      args: launch.args,
      cwd: input.cwd,
      permissionMode: input.permissionMode ?? "ask",
    });

    // posix_spawn reports ENOENT on the *binary* when cwd is missing — detect first.
    if (!input.cwd?.trim() || !existsSync(input.cwd)) {
      throw new Error(
        `agent spawn cwd does not exist: ${input.cwd || "(empty)"}\n` +
          `session: ${input.sessionKey}\n` +
          `Fix ACPBOT_REPOS_JSON / session cwd, or recreate the repo directory.`,
      );
    }

    const childEnv = {
      ...process.env,
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
          name: "acpbot",
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
    /** Fields from session/load (SDK may not expose them on ActiveSession). */
    let loadSideModels: unknown;
    let loadSideConfig: unknown;
    let loadSideModes: unknown;
    let loadSideMeta: unknown;

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
        const loadRec =
          loadResp && typeof loadResp === "object"
            ? (loadResp as Record<string, unknown>)
            : {};
        const loadMeta =
          loadRec._meta && typeof loadRec._meta === "object"
            ? (loadRec._meta as Record<string, unknown>)
            : null;
        // Grok may put SessionModelState on load (models / modelState), not only on new.
        // Keep out-of-band: ActiveSession.newSessionResponse is readonly.
        loadSideModels =
          loadRec.models ??
          loadMeta?.models ??
          loadMeta?.modelState ??
          loadRec.modelState;
        loadSideConfig = loadRec.configOptions;
        loadSideModes = loadRec.modes;
        loadSideMeta = loadMeta;
        // attachSession is public at runtime; typed private on ClientContext.
        const agentCtx = connection.agent as unknown as {
          attachSession(response: {
            sessionId: string;
            modes?: acp.SessionModeState | null;
            configOptions?: unknown;
            models?: unknown;
            _meta?: Record<string, unknown> | null;
          }): acp.ActiveSession;
        };
        session = agentCtx.attachSession({
          sessionId: prior.agentSessionId,
          modes: (loadRec.modes as acp.SessionModeState | null) ?? null,
          configOptions: loadRec.configOptions ?? null,
          ...(loadSideModels !== undefined
            ? { models: loadSideModels }
            : {}),
          _meta: loadMeta,
        });
        resumed = true;
        log.info("session/load ok", {
          sessionKey: input.sessionKey,
          agentSessionId: session.sessionId,
          loadKeys: Object.keys(loadRec),
          hasModels: Boolean(
            findModelConfigOption(
              modelsStateToConfigOptions(loadSideModels),
            ),
          ),
          hasConfigOptions: Array.isArray(loadRec.configOptions),
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
      // Grok: yoloMode in session/new _meta enables bypass for this session.
      const newMeta: Record<string, unknown> | undefined =
        input.permissionMode === "bypass"
          ? { yoloMode: true }
          : undefined;
      session = await connection.agent
        .buildSession({
          cwd: input.cwd,
          mcpServers: mcpList,
          ...(newMeta ? { _meta: newMeta } : {}),
        })
        .start();
      log.info("session/new ok", {
        sessionKey: input.sessionKey,
        agentSessionId: session.sessionId,
        mcp: mcpList.map((s) => s.name),
        hadPrior: Boolean(prior),
        permissionMode: input.permissionMode ?? "ask",
        yoloMode: Boolean(newMeta?.yoloMode),
      });
    }

    agentIdToKey.set(session.sessionId, input.sessionKey);
    agentIdToKey.set(input.sessionKey, input.sessionKey);

    // Model + meta first.
    // 1) Grok-style session.models / SessionModelState (session/set_model)
    // 2) configOptions select with category/id model (OpenCode, etc.)
    // 3) session/load side payload (when SDK omits models on ActiveSession)
    // 4) buffered _x.ai/models/update that arrived during session/new|load
    // 5) Grok effort from _meta x.ai/sessionConfig (not ACP permission modes)
    const boot = sessionNewPayload(session);
    const bootMeta =
      boot.meta ??
      (loadSideMeta && typeof loadSideMeta === "object"
        ? (loadSideMeta as Record<string, unknown>)
        : null);

    // Config options first (OpenCode puts Session Mode + model + effort here).
    let configOptions = modelsStateToConfigOptions(
      boot.models ?? loadSideModels,
    );
    let modelSource:
      | "session.models"
      | "configOptions"
      | "models-update"
      | "store"
      | "none" = "none";
    if (findModelConfigOption(configOptions)) {
      modelSource = "session.models";
    } else {
      configOptions = normalizeConfigOptions(
        boot.configOptions ?? loadSideConfig,
      );
      if (findModelConfigOption(configOptions)) {
        modelSource = "configOptions";
      }
    }
    // If modelsState path won but agent also sent configOptions (OpenCode mode),
    // merge non-model selects so mode/effort are not dropped.
    if (modelSource === "session.models") {
      const fromBoot = normalizeConfigOptions(
        boot.configOptions ?? loadSideConfig,
      );
      for (const o of fromBoot) {
        if (findModelConfigOption([o])) continue;
        if (!configOptions.some((c) => c.id === o.id)) {
          configOptions = [...configOptions, o];
        }
      }
    }
    const buffered = pendingModelConfig.get(input.sessionKey);
    if (buffered && findModelConfigOption(buffered)) {
      if (!findModelConfigOption(configOptions)) {
        configOptions = buffered;
        modelSource = "models-update";
      }
      pendingModelConfig.delete(input.sessionKey);
    }
    // Merge Grok reasoning effort as synthetic configOption (category effort).
    const effortOpts = sessionConfigEffortToConfigOptions(bootMeta);
    if (effortOpts.length > 0 && !findEffortConfigOption(configOptions)) {
      configOptions = [...configOptions, ...effortOpts];
    }

    // Permission modes: ACP session.modes (Codex/Claude), configOptions mode
    // (OpenCode), or Grok built-in default/plan/ask (not advertised on session/new
    // — see xai-org/grok-build SessionMode). Never treat effort high/medium/low as modes.
    const modeView = extractSessionModes({
      modes: session.modes ?? loadSideModes,
      configOptions,
      agent: input.agent,
      priorModeId: prior?.modeId,
    });
    const available = modeView.availableModeIds;
    // Ignore prior.modeId when it looks like Grok effort leftover (high/medium/low).
    const priorModeOk =
      prior?.modeId &&
      available.includes(prior.modeId) &&
      !isEffortLikeModeId(prior.modeId)
        ? prior.modeId
        : undefined;
    const policy =
      input.permissionMode === "bypass" ? "bypass" : "ask";
    // Align agent session mode with acpbot ask|bypass (Claude auto → default, etc.)
    let modeId: string | undefined =
      available.length > 0
        ? modeView.source === "grok.builtin"
          ? // Grok: default for ask; ask mode id is product "ask" not tool bypass
            policy === "bypass"
              ? pickModeForPermissionPolicy(available, "bypass", "default")
              : "default"
          : pickModeForPermissionPolicy(
              available,
              policy,
              priorModeOk ?? modeView.currentModeId,
            )
        : undefined;
    if (!modeId && available.length > 0) {
      modeId = pickSessionModeId(available);
    }
    if (available.length > 0 && modeId) {
      try {
        await connection.agent.request(acp.methods.agent.session.setMode, {
          sessionId: session.sessionId,
          modeId,
        });
        const modeCfg = findModeConfigOption(configOptions);
        if (modeCfg) modeCfg.currentValue = modeId;
        log.info("setMode", {
          sessionKey: input.sessionKey,
          modeId,
          source: modeView.source,
          permissionPolicy: policy,
          available,
        });
      } catch (err) {
        // OpenCode also accepts mode via set_config_option.
        const modeCfg = findModeConfigOption(configOptions);
        if (modeCfg && typeof modeId === "string") {
          try {
            await connection.agent.request(
              acp.methods.agent.session.setConfigOption,
              {
                sessionId: session.sessionId,
                configId: modeCfg.id,
                value: modeId,
              } as never,
            );
            modeCfg.currentValue = modeId;
            log.info("setMode via configOption", {
              sessionKey: input.sessionKey,
              modeId,
              configId: modeCfg.id,
            });
          } catch (cfgErr) {
            log.warn("setMode failed", {
              sessionKey: input.sessionKey,
              modeId,
              error: err instanceof Error ? err.message : String(err),
              configError:
                cfgErr instanceof Error ? cfgErr.message : String(cfgErr),
            });
          }
        } else {
          log.warn("setMode failed", {
            sessionKey: input.sessionKey,
            modeId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else {
      log.info("session modes", {
        sessionKey: input.sessionKey,
        source: modeView.source,
        available,
        current: modeId ?? null,
      });
    }
    log.info("session models/config", {
      sessionKey: input.sessionKey,
      modelCount: findModelConfigOption(configOptions)?.options.length ?? 0,
      current: findModelConfigOption(configOptions)?.currentValue ?? null,
      effort: findEffortConfigOption(configOptions)?.currentValue ?? null,
      mode: modeId ?? null,
      modeCount: available.length,
      source: modelSource,
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
      permissionMode: input.permissionMode === "bypass"
        ? "bypass"
        : "ask",
      turnAbort: undefined,
    };
    live.set(input.sessionKey, entry);

    // Late `_x.ai/models/update` (common on session/new; rare on load).
    if (!findModelConfigOption(entry.configOptions)) {
      await waitForLateModels(input.sessionKey, entry, 2000);
      if (findModelConfigOption(entry.configOptions)) {
        modelSource = "models-update";
        log.info("session models/config (after wait)", {
          sessionKey: input.sessionKey,
          modelCount:
            findModelConfigOption(entry.configOptions)?.options.length ?? 0,
          current:
            findModelConfigOption(entry.configOptions)?.currentValue ?? null,
          source: modelSource,
        });
      }
    }

    // session/load often omits models until a turn; keep last-known for /status.
    if (!findModelConfigOption(entry.configOptions) && prior?.modelId) {
      entry.configOptions = seedModelConfigFromId(prior.modelId);
      modelSource = "store";
      log.info("session models/config seeded from store", {
        sessionKey: input.sessionKey,
        modelId: prior.modelId,
      });
    }

    const knownModel = modelIdFromConfig(entry.configOptions);
    await persistRecord({
      sessionKey: input.sessionKey,
      agentSessionId: session.sessionId,
      agent: input.agent,
      cwd: input.cwd,
      ...(modeId ? { modeId } : {}),
      ...(knownModel ? { modelId: knownModel } : {}),
      ...(prior?.createdAt ? { createdAt: prior.createdAt } : {}),
    });

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
    pendingModelConfig.delete(sessionKey);
    log.info("disposed live session", { sessionKey, agent: entry.agent });
  }

  return {
    setHooks(next) {
      hooks = { ...hooks, ...next };
    },

    async ensureSession(input) {
      const existing = live.get(input.sessionKey);
      if (existing) {
        // Agent/cwd change or force (post-OAuth MCP rebuild) → kill and respawn.
        if (
          input.forceRespawn ||
          existing.agent !== input.agent ||
          existing.cwd !== input.cwd
        ) {
          log.info(
            input.forceRespawn
              ? "ensureSession: forceRespawn; rebuilding MCP"
              : "ensureSession: agent/cwd changed; respawning",
            {
              sessionKey: input.sessionKey,
              fromAgent: existing.agent,
              toAgent: input.agent,
              forceRespawn: Boolean(input.forceRespawn),
            },
          );
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
      // Refresh available modes from configOptions if ACP modes were empty (OpenCode).
      syncModesFromConfigOptions(entry);
      let applied = false;
      try {
        await entry.connection.agent.request(acp.methods.agent.session.setMode, {
          sessionId: entry.session.sessionId,
          modeId,
        });
        applied = true;
      } catch (setModeErr) {
        const modeCfg = findModeConfigOption(entry.configOptions);
        if (modeCfg) {
          try {
            await entry.connection.agent.request(
              acp.methods.agent.session.setConfigOption,
              {
                sessionId: entry.session.sessionId,
                configId: modeCfg.id,
                value: modeId,
              } as never,
            );
            applied = true;
            log.info("setMode via configOption", {
              sessionKey,
              modeId,
              configId: modeCfg.id,
            });
          } catch {
            throw setModeErr instanceof Error
              ? setModeErr
              : new Error(String(setModeErr));
          }
        } else {
          throw setModeErr instanceof Error
            ? setModeErr
            : new Error(String(setModeErr));
        }
      }
      if (!applied) {
        throw new Error(`failed to set mode ${modeId}`);
      }
      entry.currentModeId = modeId;
      const modeCfg = findModeConfigOption(entry.configOptions);
      if (modeCfg) modeCfg.currentValue = modeId;
      if (
        entry.availableModeIds.length === 0 &&
        modeCfg &&
        modeCfg.options.length > 0
      ) {
        entry.availableModeIds = modeCfg.options.map((o) => o.value);
      }
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

    async getModeState(sessionKey) {
      const entry = live.get(sessionKey);
      if (!entry) return undefined;
      syncModesFromConfigOptions(entry);
      return {
        currentModeId: entry.currentModeId,
        availableModeIds: entry.availableModeIds,
      };
    },

    async getAvailableModes(sessionKey) {
      const entry = live.get(sessionKey);
      if (!entry) return [];
      syncModesFromConfigOptions(entry);
      if (entry.availableModeIds.length > 0) return [...entry.availableModeIds];
      const modes = entry.session.modes;
      return (
        modes?.availableModes?.map((m) => m.id) ??
        (modes as { available?: Array<{ id: string }> } | null | undefined)
          ?.available?.map((m) => m.id) ??
        []
      );
    },

    async getConfigOptions(sessionKey) {
      const entry = live.get(sessionKey);
      if (!entry) return [];
      // Prefer latest from session/new payload when it includes a model select.
      const boot = sessionNewPayload(entry.session);
      const prevEffort = findEffortConfigOption(entry.configOptions);
      const prevMode = findModeConfigOption(entry.configOptions);
      const fromAgent = normalizeConfigOptions(boot.configOptions);
      if (findModelConfigOption(fromAgent)) {
        entry.configOptions = fromAgent;
      } else {
        const fromModels = modelsStateToConfigOptions(boot.models);
        if (findModelConfigOption(fromModels)) {
          entry.configOptions = fromModels;
        }
      }
      // Keep OpenCode mode select if model refresh dropped non-model options.
      if (!findModeConfigOption(entry.configOptions)) {
        if (fromAgent.length > 0) {
          for (const o of fromAgent) {
            if (findModelConfigOption([o])) continue;
            if (!entry.configOptions.some((c) => c.id === o.id)) {
              entry.configOptions = [...entry.configOptions, o];
            }
          }
        } else if (prevMode) {
          entry.configOptions = [...entry.configOptions, prevMode];
        }
      }
      // Re-merge Grok effort if model refresh dropped it.
      if (!findEffortConfigOption(entry.configOptions)) {
        const fromMeta = sessionConfigEffortToConfigOptions(boot.meta);
        if (fromMeta.length > 0) {
          entry.configOptions = [...entry.configOptions, ...fromMeta];
        } else if (prevEffort) {
          entry.configOptions = [...entry.configOptions, prevEffort];
        }
      }
      syncModesFromConfigOptions(entry);
      // Otherwise keep entry.configOptions (session.models / _x.ai/models/update).
      return [...entry.configOptions];
    },

    async setConfigOption(sessionKey, configId, value) {
      const entry = live.get(sessionKey);
      if (!entry) {
        throw new Error(`no live session for ${sessionKey}`);
      }

      // Grok Build uses dedicated session/set_model (not set_config_option).
      // https://github.com/xai-org/grok-build — SetSessionModelRequest
      if (
        typeof value === "string" &&
        (configId === "model" || /model/i.test(configId)) &&
        !isEffortConfigId(configId)
      ) {
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
            // Preserve effort option if models response replaces the list.
            const prevEffort = findEffortConfigOption(entry.configOptions);
            entry.configOptions = fromResp;
            if (prevEffort && !findEffortConfigOption(entry.configOptions)) {
              entry.configOptions = [...entry.configOptions, prevEffort];
            }
          } else {
            const hit = findModelConfigOption(entry.configOptions);
            if (hit) hit.currentValue = value;
          }
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

      // OpenCode Session Mode config select → keep live mode state in sync.
      if (
        typeof value === "string" &&
        (configId === "mode" || configId === "session_mode")
      ) {
        try {
          const resp = await entry.connection.agent.request(
            acp.methods.agent.session.setConfigOption,
            {
              sessionId: entry.session.sessionId,
              configId,
              value,
            } as never,
          );
          const nextRaw =
            (resp as { configOptions?: unknown })?.configOptions ??
            sessionNewPayload(entry.session).configOptions;
          if (nextRaw) {
            const prevEffort = findEffortConfigOption(entry.configOptions);
            entry.configOptions = normalizeConfigOptions(nextRaw);
            if (prevEffort && !findEffortConfigOption(entry.configOptions)) {
              entry.configOptions = [...entry.configOptions, prevEffort];
            }
          }
          const modeCfg = findModeConfigOption(entry.configOptions);
          if (modeCfg) modeCfg.currentValue = value;
          entry.currentModeId = value;
          if (modeCfg && modeCfg.options.length > 0) {
            entry.availableModeIds = modeCfg.options.map((o) => o.value);
          }
          await persistRecord({
            sessionKey: entry.sessionKey,
            agentSessionId: entry.session.sessionId,
            agent: entry.agent,
            cwd: entry.cwd,
            modeId: value,
          });
          log.info("setConfigOption mode ok", { sessionKey, modeId: value });
          return [...entry.configOptions];
        } catch (modeCfgErr) {
          // Fall through to set_mode path below / native path
          log.debug("set_config mode failed; trying set_mode", {
            sessionKey,
            error:
              modeCfgErr instanceof Error
                ? modeCfgErr.message
                : String(modeCfgErr),
          });
          try {
            await entry.connection.agent.request(
              acp.methods.agent.session.setMode,
              {
                sessionId: entry.session.sessionId,
                modeId: value,
              },
            );
            entry.currentModeId = value;
            const modeCfg = findModeConfigOption(entry.configOptions);
            if (modeCfg) modeCfg.currentValue = value;
            log.info("set mode via set_mode after config fail", {
              sessionKey,
              modeId: value,
            });
            return [...entry.configOptions];
          } catch {
            /* native path below */
          }
        }
      }

      // Grok reasoning effort is advertised under sessionConfig category "mode"
      // and applied via session/set_mode (same RPC as permission modes on Codex).
      if (typeof value === "string" && isEffortConfigId(configId)) {
        try {
          await entry.connection.agent.request(
            acp.methods.agent.session.setMode,
            {
              sessionId: entry.session.sessionId,
              modeId: value,
            },
          );
          const effort = findEffortConfigOption(entry.configOptions);
          if (effort) {
            effort.currentValue = value;
          } else {
            entry.configOptions = [
              ...entry.configOptions,
              {
                id: "effort",
                name: "Effort",
                type: "select",
                category: "effort",
                currentValue: value,
                options: [
                  { value: "high", name: "high" },
                  { value: "medium", name: "medium" },
                  { value: "low", name: "low" },
                ],
              },
            ];
          }
          log.info("set effort ok (session/set_mode)", {
            sessionKey,
            effort: value,
          });
          return [...entry.configOptions];
        } catch (effortErr) {
          log.debug("session/set_mode for effort failed; trying set_config", {
            sessionKey,
            error:
              effortErr instanceof Error
                ? effortErr.message
                : String(effortErr),
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
      const resp = await entry.connection.agent.request(
        acp.methods.agent.session.setConfigOption,
        params as never,
      );
      const nextRaw =
        (resp as { configOptions?: unknown })?.configOptions ??
        sessionNewPayload(entry.session).configOptions;
      const prevEffort = findEffortConfigOption(entry.configOptions);
      entry.configOptions = normalizeConfigOptions(nextRaw);
      if (prevEffort && !findEffortConfigOption(entry.configOptions)) {
        entry.configOptions = [...entry.configOptions, prevEffort];
      }
      const hit = entry.configOptions.find((o) => o.id === configId);
      if (hit) hit.currentValue = value;
      log.info("setConfigOption ok (ACP)", {
        sessionKey,
        configId,
        value: String(value),
      });
      return [...entry.configOptions];
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
