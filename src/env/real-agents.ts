import { randomUUID } from "node:crypto";
import type {
  AcpTurnEvent,
  AgentSessionHandle,
  AgentsPort,
  ElicitationDecision,
  ElicitationRequest,
  PermissionDecision,
  PermissionRequest,
  PromptTurn,
  PromptTurnInput,
  SessionIdentity,
  TacpConfig,
} from "./types";
import { silentLogger } from "./logger";
import { buildTacpMcpServers } from "../mcp/servers";

export type RealAgentsOptions = {
  config: TacpConfig;
  /**
   * Directory for acpx's injectable session store. Configuration — never a
   * hardcoded home path inside this module.
   */
  acpxStateDir: string;
  /** When true, log verbose acpx diagnostics. */
  verbose?: boolean;
  log?: import("./logger").Logger;
  /**
   * If true, force a read-only-ish session mode after create (disables many
   * agent tools including shell). Default false — terminal needs a non-RO mode.
   */
  forceReadOnly?: boolean;
  /**
   * Test/production seam: inject a pre-built runtime. When omitted, loads
   * acpx/runtime and constructs via createAcpRuntime (the shipped path).
   */
  runtime?: Runtime;
};

export type RuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
};

export type Runtime = {
  ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
  }): Promise<RuntimeHandle>;
  startTurn(input: {
    handle: RuntimeHandle;
    text: string;
    mode: "prompt" | "steer";
    requestId: string;
    signal?: AbortSignal;
    attachments?: Array<{ mediaType: string; data: string }>;
  }): {
    events: AsyncIterable<{
      type: string;
      text?: string;
      stream?: string;
      toolCallId?: string;
      title?: string;
      status?: string;
      message?: string;
      stopReason?: string;
    }>;
    result: Promise<{
      status: string;
      stopReason?: string;
      error?: { message?: string };
    }>;
    cancel?(input?: { reason?: string }): Promise<void>;
  };
  setMode?(input: { handle: RuntimeHandle; mode: string }): Promise<void>;
  cancel?(input: { handle: RuntimeHandle; reason?: string }): Promise<void>;
  getStatus?(input: {
    handle: RuntimeHandle;
  }): Promise<{
    details?: {
      modes?: { current?: string; available?: Array<{ id: string }> };
      currentModeId?: string;
      availableModeIds?: string[];
    };
    summary?: string;
  }>;
};

type AcpRuntimeModule = {
  createAcpRuntime: (o: Record<string, unknown>) => Runtime;
  createAgentRegistry: (o?: {
    overrides?: Record<string, string | string[]>;
  }) => unknown;
  createRuntimeStore: (o: { stateDir: string }) => unknown;
  createFileSessionStore: (o: { stateDir: string }) => unknown;
};

/**
 * Build options passed to createAcpRuntime. Exported so tests assert the
 * shipped option object never includes timeoutMs and always supplies store +
 * registry.
 */
export function buildAcpRuntimeOptions(input: {
  config: TacpConfig;
  acpxStateDir: string;
  verbose?: boolean;
  sessionStore: unknown;
  agentRegistry: unknown;
  onPermissionRequest: (
    req: { sessionId: string; raw: unknown },
    ctx: { signal: AbortSignal },
  ) => Promise<PermissionDecision | undefined>;
  onElicitationRequest: (
    req: { sessionId?: string; raw: unknown },
    ctx: { signal: AbortSignal },
  ) => Promise<ElicitationDecision | undefined | { action: "decline" }>;
  /**
   * Grok `_x.ai/ask_user_question`. Must be present on AcpClient options or
   * the agent gets methodNotFound and falls back to prose.
   */
  onAskUserQuestion?: (
    req: { sessionId?: string; raw: unknown },
    ctx: { signal: AbortSignal },
  ) => Promise<Record<string, unknown>>;
  /**
   * Override host MCP servers (default: tacp FastMCP speak server).
   * Pass [] to disable.
   */
  mcpServers?: unknown[];
}): Record<string, unknown> {
  const cwd =
    input.config.repos && Object.keys(input.config.repos).length > 0
      ? (Object.values(input.config.repos)[0] as string)
      : process.cwd();

  const mcpServers =
    input.mcpServers ??
    buildTacpMcpServers({
      enabled: input.config.mcpEnabled !== false,
    });

  // Intentionally construct without a timeoutMs key.
  return {
    cwd,
    sessionStore: input.sessionStore,
    agentRegistry: input.agentRegistry,
    // Host tools for the agent (speak TTS now; STT later).
    mcpServers,
    // Client-side terminal/* and fs/* are gated by permissionMode, NOT by
    // onPermissionRequest. "deny-all" yields "Permission denied for terminal/create"
    // with no Telegram prompt. Use approve-all for the client execution surface;
    // agent session/request_permission still hits onPermissionRequest → chat UI.
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    verbose: input.verbose ?? false,
    onPermissionRequest: input.onPermissionRequest,
    onElicitationRequest: input.onElicitationRequest,
    // Forward even when undefined so callers see the key was considered; acpx
    // only registers the ext method when the function is truthy.
    ...(input.onAskUserQuestion
      ? { onAskUserQuestion: input.onAskUserQuestion }
      : {}),
  };
}

/**
 * Prefer interactive/default modes so Grok keeps terminal + tools.
 * Only pick pure read-only when explicitly requested via options.forceReadOnly.
 */
export function pickSessionModeId(
  available: string[],
  opts?: { forceReadOnly?: boolean },
): string | undefined {
  if (available.length === 0) {
    return opts?.forceReadOnly ? "read-only" : undefined;
  }
  if (opts?.forceReadOnly) {
    const preferRo = ["read-only", "read_only", "ask", "plan", "default"];
    for (const id of preferRo) {
      if (available.includes(id)) return id;
    }
    return available[0];
  }
  // Avoid locking the agent out of shell/tools (read-only / plan).
  const prefer = ["default", "ask", "code", "agent", "full", "edit"];
  for (const id of prefer) {
    if (available.includes(id)) return id;
  }
  const nonRo = available.find((id) => !/read.?only|plan/i.test(id));
  return nonRo ?? available[0];
}

/** @deprecated use pickSessionModeId — kept for older tests */
export function pickReadOnlyModeId(available: string[]): string | undefined {
  return pickSessionModeId(available, { forceReadOnly: true });
}

/**
 * Agents port backed by the local acpx fork (`acpx/runtime`).
 *
 * - sessionStore + agentRegistry always supplied (required by the runtime)
 * - timeoutMs never set on turns or runtime options
 * - Client terminal/fs: permissionMode approve-all (deny-all blocks terminal/create)
 * - Agent tool permissions: onPermissionRequest → Telegram keyboard
 */
export function realAgents(options: RealAgentsOptions): AgentsPort {
  const log = (options.log ?? silentLogger()).child("acp");
  const handles = new Map<
    string,
    { runtimeHandle: RuntimeHandle; identity: SessionIdentity; cwd: string }
  >();
  /** agentSessionId / acpx session id → tacp sessionKey for permission routing */
  const agentIdToSessionKey = new Map<string, string>();
  const abortBySession = new Map<string, AbortController>();
  let runtimePromise: Promise<Runtime> | undefined;
  let permissionHandler:
    | ((
        req: PermissionRequest,
        ctx: { signal: AbortSignal },
      ) => Promise<PermissionDecision | undefined>)
    | undefined;
  let elicitationHandler:
    | ((
        req: ElicitationRequest,
        ctx: { signal: AbortSignal },
      ) => Promise<ElicitationDecision | undefined>)
    | undefined;
  let askUserQuestionHandler:
    | ((
        req: { sessionId: string; raw: unknown },
        ctx: { signal: AbortSignal },
      ) => Promise<Record<string, unknown>>)
    | undefined;

  const sessionKeyOf = (id: SessionIdentity) => `${id.repo}/${id.name}`;

  /** Resolve tacp session key from an acpx/agent session id. */
  function resolveSessionKey(agentOrTacpId: string): string {
    return agentIdToSessionKey.get(agentOrTacpId) ?? agentOrTacpId;
  }

  async function getRuntime(): Promise<Runtime> {
    if (options.runtime) return options.runtime;
    if (!runtimePromise) {
      runtimePromise = (async () => {
        const mod = (await import("acpx/runtime")) as unknown as AcpRuntimeModule;
        const createRuntimeStore =
          mod.createRuntimeStore ?? mod.createFileSessionStore;

        const onPermissionRequest = async (
          req: { sessionId: string; raw: unknown },
          ctx: { signal: AbortSignal },
        ) => {
          const raw = req.raw as { toolCall?: { toolCallId?: string } };
          const toolCallId = raw?.toolCall?.toolCallId ?? "unknown";
          const sessionKey = resolveSessionKey(req.sessionId);
          log.info("permission request from agent", {
            sessionKey,
            agentSessionId: req.sessionId,
            toolCallId,
          });
          if (permissionHandler) {
            const decision = await permissionHandler(
              { sessionId: sessionKey, toolCallId, raw: req.raw },
              ctx,
            );
            log.info("permission decision", {
              sessionKey,
              toolCallId,
              decision,
            });
            return decision;
          }
          log.warn("no permission handler; reject_once", { sessionKey });
          return { outcome: "reject_once" as const };
        };

        const runtimeOpts = buildAcpRuntimeOptions({
          config: options.config,
          acpxStateDir: options.acpxStateDir,
          verbose: options.verbose,
          sessionStore: createRuntimeStore({
            stateDir: options.acpxStateDir,
          }),
          agentRegistry: mod.createAgentRegistry(),
          onPermissionRequest,
          onElicitationRequest: async (
            req: { sessionId?: string; raw: unknown },
            ctx: { signal: AbortSignal },
          ) => {
            const sessionKey = resolveSessionKey(
              req.sessionId ?? "unknown",
            );
            log.info("elicitation request from agent", {
              sessionKey,
              agentSessionId: req.sessionId,
            });
            if (elicitationHandler) {
              const decision = await elicitationHandler(
                { sessionId: sessionKey, raw: req.raw },
                ctx,
              );
              log.info("elicitation decision", { sessionKey, decision });
              return decision;
            }
            log.warn("no elicitation handler; decline", { sessionKey });
            return { action: "decline" as const };
          },
          onAskUserQuestion: async (
            req: { sessionId?: string; raw: unknown },
            ctx: { signal: AbortSignal },
          ) => {
            const sessionKey = resolveSessionKey(
              req.sessionId ?? "unknown",
            );
            log.info("ask_user_question from agent", {
              sessionKey,
              agentSessionId: req.sessionId,
            });
            if (!askUserQuestionHandler) {
              log.warn("no ask_user_question handler; skip_interview");
              // Grok AskUserQuestionExtResponse::SkipInterview
              return { outcome: "skip_interview" };
            }
            const result = await askUserQuestionHandler(
              { sessionId: sessionKey, raw: req.raw },
              ctx,
            );
            log.info("ask_user_question answered", {
              sessionKey,
              outcome: result.outcome,
              answers: result.answers ?? result,
            });
            return result;
          },
        });

        if ("timeoutMs" in runtimeOpts) {
          throw new Error("bug: timeoutMs must never be set on AcpRuntimeOptions");
        }
        if (typeof runtimeOpts.onAskUserQuestion !== "function") {
          throw new Error(
            "bug: onAskUserQuestion missing from AcpRuntimeOptions — Grok multi-choice will methodNotFound",
          );
        }
        const mcpList = Array.isArray(runtimeOpts.mcpServers)
          ? (runtimeOpts.mcpServers as Array<{ name?: string }>)
          : [];
        log.info("createAcpRuntime", {
          hasAskUserQuestion: true,
          hasElicitation: typeof runtimeOpts.onElicitationRequest === "function",
          permissionMode: runtimeOpts.permissionMode,
          mcpServers: mcpList.map((s) => s.name ?? "?"),
        });

        return mod.createAcpRuntime(runtimeOpts);
      })();
    }
    return runtimePromise;
  }

  async function resolveSessionModeId(
    runtime: Runtime,
    handle: RuntimeHandle,
  ): Promise<string | undefined> {
    if (!runtime.getStatus) {
      return options.forceReadOnly ? "read-only" : undefined;
    }
    try {
      const st = await runtime.getStatus({ handle });
      const available =
        st.details?.modes?.available?.map((m) => m.id) ??
        st.details?.availableModeIds ??
        [];
      return pickSessionModeId(available, {
        forceReadOnly: options.forceReadOnly === true,
      });
    } catch {
      return options.forceReadOnly ? "read-only" : undefined;
    }
  }

  return {
    // Handlers are read via closures on every request — do not rebuild the
    // runtime (that would orphan live AcpClient sessions). Hooks must already
    // be present on createAcpRuntime options (see buildAcpRuntimeOptions).
    setPermissionHandler(handler) {
      permissionHandler = handler;
    },

    setElicitationHandler(handler) {
      elicitationHandler = handler;
    },

    setAskUserQuestionHandler(handler) {
      askUserQuestionHandler = handler;
    },

    async cancelTurn(sessionKey, reason) {
      const ac = abortBySession.get(sessionKey);
      ac?.abort();
      abortBySession.delete(sessionKey);
      const entry = handles.get(sessionKey);
      if (!entry) return;
      const runtime = await getRuntime();
      if (runtime.cancel) {
        try {
          await runtime.cancel({
            handle: entry.runtimeHandle,
            reason: reason ?? "operator cancel",
          });
        } catch {
          /* best effort */
        }
      }
    },

    async ensureSession(identity) {
      const key = sessionKeyOf(identity);
      const existing = handles.get(key);
      if (existing) {
        return {
          sessionKey: key,
          identity: existing.identity,
          cwd: existing.cwd,
        };
      }

      const repos = options.config.repos ?? {};
      const cwd = repos[identity.repo];
      if (!cwd) {
        throw new Error(
          `unknown repo "${identity.repo}" — add it to TACP_REPOS_JSON / config.repos`,
        );
      }

      const runtime = await getRuntime();
      const agent = identity.agent ?? options.config.defaultAgent ?? "codex";

      // Only pin Codex initial mode when forceReadOnly is on.
      const prevEnv = process.env.ACPX_CODEX_INITIAL_MODE;
      if (
        options.forceReadOnly &&
        (agent === "codex" || agent.includes("codex"))
      ) {
        process.env.ACPX_CODEX_INITIAL_MODE =
          process.env.ACPX_CODEX_INITIAL_MODE ?? "read-only";
      }

      log.info("ensureSession", { sessionKey: key, agent, cwd });
      let runtimeHandle: RuntimeHandle;
      try {
        runtimeHandle = await runtime.ensureSession({
          sessionKey: key,
          agent,
          mode: "persistent",
          cwd,
        });
        log.info("ensureSession ok", {
          sessionKey: key,
          agentSessionId: runtimeHandle.agentSessionId,
          acpxRecordId: runtimeHandle.acpxRecordId,
        });
      } catch (err) {
        log.error("ensureSession failed", {
          sessionKey: key,
          agent,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        if (prevEnv === undefined) delete process.env.ACPX_CODEX_INITIAL_MODE;
        else process.env.ACPX_CODEX_INITIAL_MODE = prevEnv;
      }

      if (runtime.setMode) {
        const modeId = await resolveSessionModeId(runtime, runtimeHandle);
        if (modeId) {
          try {
            await runtime.setMode({ handle: runtimeHandle, mode: modeId });
            log.info("setMode", { sessionKey: key, modeId });
          } catch (err) {
            log.warn("setMode failed", {
              sessionKey: key,
              modeId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          log.info("setMode skipped (leave agent default for terminal/tools)", {
            sessionKey: key,
          });
        }
      }

      const resolvedIdentity = { ...identity, agent };
      handles.set(key, { runtimeHandle, identity: resolvedIdentity, cwd });
      agentIdToSessionKey.set(key, key);
      if (runtimeHandle.agentSessionId) {
        agentIdToSessionKey.set(runtimeHandle.agentSessionId, key);
      }
      if (runtimeHandle.acpxRecordId) {
        agentIdToSessionKey.set(runtimeHandle.acpxRecordId, key);
      }
      if (runtimeHandle.backendSessionId) {
        agentIdToSessionKey.set(runtimeHandle.backendSessionId, key);
      }

      return {
        sessionKey: key,
        identity: resolvedIdentity,
        cwd,
      } satisfies AgentSessionHandle;
    },

    async runPromptTurn(
      handle: AgentSessionHandle,
      input: PromptTurnInput,
    ): Promise<PromptTurn> {
      const entry = handles.get(handle.sessionKey);
      if (!entry) {
        throw new Error(
          `no live agent handle for ${handle.sessionKey} — create the session first`,
        );
      }

      if (
        input !== null &&
        typeof input === "object" &&
        "timeoutMs" in (input as object)
      ) {
        throw new Error("timeoutMs must never be set on a turn");
      }

      const runtime = await getRuntime();
      const requestId = randomUUID();
      const ac = new AbortController();
      abortBySession.set(handle.sessionKey, ac);
      if (input.signal) {
        if (input.signal.aborted) ac.abort();
        else {
          input.signal.addEventListener("abort", () => ac.abort(), {
            once: true,
          });
        }
      }

      // No timeoutMs property on the object passed to startTurn.
      const turnArgs: {
        handle: RuntimeHandle;
        text: string;
        mode: "prompt" | "steer";
        requestId: string;
        signal?: AbortSignal;
        attachments?: Array<{ mediaType: string; data: string }>;
      } = {
        handle: entry.runtimeHandle,
        text: input.text,
        mode: input.mode === "steer" ? "steer" : "prompt",
        requestId,
        signal: ac.signal,
        ...(input.attachments && input.attachments.length > 0
          ? {
              attachments: input.attachments.map((a) => ({
                mediaType: a.mediaType,
                data: a.data,
              })),
            }
          : {}),
      };

      if ("timeoutMs" in turnArgs) {
        throw new Error("bug: timeoutMs leaked onto startTurn input");
      }

      log.info("startTurn", {
        sessionKey: handle.sessionKey,
        mode: turnArgs.mode,
        requestId,
        promptLen: input.text.length,
        attachments: input.attachments?.length ?? 0,
        promptPreview:
          input.text.length > 120
            ? `${input.text.slice(0, 120)}…`
            : input.text,
      });
      const turn = runtime.startTurn(turnArgs);

      const events = (async function* (): AsyncGenerator<AcpTurnEvent> {
        yield { type: "turn_started" };
        let textChars = 0;
        let thoughtChars = 0;
        let toolCalls = 0;
        // Buffer partial streams so logs show readable sentences, not every token.
        let outBuf = "";
        let thoughtBuf = "";
        const sk = handle.sessionKey;

        const flushOut = (force = false) => {
          if (!outBuf) return;
          if (!force && outBuf.length < 80 && !outBuf.includes("\n")) return;
          const chunk = outBuf;
          outBuf = "";
          log.info("agent says", {
            sessionKey: sk,
            text: previewText(chunk, 400),
          });
        };
        const flushThought = (force = false) => {
          if (!thoughtBuf) return;
          if (!force && thoughtBuf.length < 80 && !thoughtBuf.includes("\n")) {
            return;
          }
          const chunk = thoughtBuf;
          thoughtBuf = "";
          log.info("agent thinks", {
            sessionKey: sk,
            text: previewText(chunk, 400),
          });
        };

        try {
          for await (const ev of turn.events) {
            if (ev.type === "text_delta") {
              const piece = String(ev.text ?? "");
              if (ev.stream === "thought") {
                thoughtChars += piece.length;
                thoughtBuf += piece;
                flushThought(false);
                // No per-token thought_delta logs — flushThought → "agent thinks"
              } else {
                // output or unspecified
                textChars += piece.length;
                outBuf += piece;
                flushOut(false);
                // No per-token text_delta logs — flushOut → "agent says"
                yield {
                  type: "agent_message_chunk",
                  text: piece,
                };
              }
            } else if (ev.type === "tool_call") {
              toolCalls += 1;
              flushOut(true);
              flushThought(true);
              const title =
                typeof ev.title === "string" ? ev.title : ev.text;
              log.info("agent tool", {
                sessionKey: sk,
                toolCallId: ev.toolCallId,
                status: ev.status,
                kind: ev.kind,
                title: title ? previewText(String(title), 200) : undefined,
                locations: summarizeLocations(ev.locations),
                input: summarizeJson(ev.rawInput, 300),
                output: summarizeJson(ev.rawOutput, 300),
              });
              log.debug("acp tool_call full", {
                sessionKey: sk,
                toolCallId: ev.toolCallId,
                tag: ev.tag,
                text: ev.text ? previewText(String(ev.text), 200) : undefined,
              });
              yield {
                type: "tool_call",
                toolCallId: String(ev.toolCallId ?? ""),
                title: typeof title === "string" ? title : undefined,
                rawInput: (ev as { rawInput?: unknown }).rawInput,
              };
            } else if (ev.type === "status") {
              log.info("agent status", {
                sessionKey: sk,
                tag: ev.tag,
                text: ev.text ? previewText(String(ev.text), 240) : undefined,
                used: ev.used,
                size: ev.size,
                cost: ev.cost,
              });
            } else if (ev.type === "error") {
              flushOut(true);
              flushThought(true);
              log.error("acp error event", {
                sessionKey: sk,
                message: ev.message,
                code: ev.code,
                detailCode: ev.detailCode,
              });
              yield {
                type: "process_died",
                error: String(ev.message ?? "agent error"),
              };
            } else if (ev.type === "done") {
              flushOut(true);
              flushThought(true);
              log.info("acp done event", {
                sessionKey: sk,
                stopReason: ev.stopReason,
              });
              yield {
                type: "turn_ended",
                stopReason: String(ev.stopReason ?? "end_turn"),
              };
            } else {
              log.debug("acp event (other)", {
                sessionKey: sk,
                type: (ev as { type?: string }).type,
              });
            }
          }

          flushOut(true);
          flushThought(true);

          const result = await turn.result;
          log.info("turn result", {
            sessionKey: sk,
            status: result.status,
            stopReason: result.stopReason,
            textChars,
            thoughtChars,
            toolCalls,
            error:
              result.status === "failed"
                ? result.error?.message
                : undefined,
          });
          if (result.status === "failed") {
            yield {
              type: "process_died",
              error: result.error?.message ?? "turn failed",
            };
          } else if (result.status === "cancelled") {
            yield { type: "turn_ended", stopReason: "cancelled" };
          } else {
            yield {
              type: "turn_ended",
              stopReason: result.stopReason ?? "end_turn",
            };
          }
        } catch (err) {
          flushOut(true);
          flushThought(true);
          log.error("turn stream failed", {
            sessionKey: sk,
            error: err instanceof Error ? err.message : String(err),
          });
          yield {
            type: "process_died",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })();

      const done = turn.result
        .then((r) => {
          if (r.status === "failed") {
            throw new Error(r.error?.message ?? "turn failed");
          }
          return { stopReason: r.stopReason ?? r.status };
        })
        .finally(() => {
          abortBySession.delete(handle.sessionKey);
        });

      return { events, done };
    },
  };
}

function previewText(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…(+${t.length - max})`;
}

function summarizeJson(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const s =
      typeof value === "string" ? value : JSON.stringify(value, null, 0);
    return previewText(s, max);
  } catch {
    return "[unserializable]";
  }
}

function summarizeLocations(
  locations: unknown,
): Array<{ path?: string }> | undefined {
  if (!Array.isArray(locations) || locations.length === 0) return undefined;
  return locations.slice(0, 8).map((loc) => {
    if (loc && typeof loc === "object" && "path" in loc) {
      return { path: String((loc as { path: unknown }).path) };
    }
    return {};
  });
}
