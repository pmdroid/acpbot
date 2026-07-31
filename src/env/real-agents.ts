/**
 * Agents port backed by the thin ACP host (@agentclientprotocol/sdk).
 */
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
import {
  createSessionHost,
  type SessionHost,
  type HostTurnEvent,
} from "../acp/session-host";
import {
  pickSessionModeId,
  pickReadOnlyModeId,
} from "../acp/session-mode";

export { pickSessionModeId, pickReadOnlyModeId };

export type RealAgentsOptions = {
  config: TacpConfig;
  /**
   * Directory reserved for host state (compat name from acpx era).
   * Thin host currently keeps process state in memory.
   */
  acpxStateDir: string;
  verbose?: boolean;
  log?: import("./logger").Logger;
  forceReadOnly?: boolean;
  /** Test seam: inject a pre-built host. */
  host?: SessionHost;
};

/**
 * @deprecated acpx option builder — kept as a thin shim for older tests.
 * Prefer createSessionHost / realAgents.
 */
export function buildAcpRuntimeOptions(input: {
  config: TacpConfig;
  acpxStateDir: string;
  verbose?: boolean;
  sessionStore?: unknown;
  agentRegistry?: unknown;
  onPermissionRequest: (
    req: { sessionId: string; raw: unknown },
    ctx: { signal: AbortSignal },
  ) => Promise<PermissionDecision | undefined>;
  onElicitationRequest: (
    req: { sessionId?: string; raw: unknown },
    ctx: { signal: AbortSignal },
  ) => Promise<ElicitationDecision | undefined | { action: "decline" }>;
  onAskUserQuestion?: (
    req: { sessionId?: string; raw: unknown },
    ctx: { signal: AbortSignal },
  ) => Promise<Record<string, unknown>>;
  mcpServers?: unknown[];
}): Record<string, unknown> {
  return {
    cwd:
      input.config.repos && Object.keys(input.config.repos).length > 0
        ? (Object.values(input.config.repos)[0] as string)
        : process.cwd(),
    // Never set timeoutMs
    onPermissionRequest: input.onPermissionRequest,
    onElicitationRequest: input.onElicitationRequest,
    ...(input.onAskUserQuestion
      ? { onAskUserQuestion: input.onAskUserQuestion }
      : {}),
    mcpServers: input.mcpServers,
    backend: "acp-sdk",
  };
}

/** @deprecated test inject type — use SessionHost */
export type RuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
  agentSessionId?: string;
};

/** @deprecated */
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
    events: AsyncIterable<HostTurnEvent>;
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
      availableModeIds?: string[];
    };
  }>;
};

export function realAgents(options: RealAgentsOptions): AgentsPort {
  const log = (options.log ?? silentLogger()).child("acp");
  const handles = new Map<
    string,
    { identity: SessionIdentity; cwd: string; agentSessionId: string }
  >();
  const abortBySession = new Map<string, AbortController>();

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

  const host: SessionHost =
    options.host ??
    createSessionHost({
      config: options.config,
      stateDir: options.acpxStateDir,
      ...(options.config.mcpEnabled !== undefined
        ? { mcpEnabled: options.config.mcpEnabled }
        : {}),
      log,
      hooks: {
        onPermissionRequest: async (req, ctx) => {
          if (permissionHandler) return permissionHandler(req, ctx);
          log.warn("no permission handler; reject_once", {
            sessionKey: req.sessionId,
          });
          return { outcome: "reject_once" };
        },
        onElicitationRequest: async (req, ctx) => {
          if (elicitationHandler) return elicitationHandler(req, ctx);
          return { action: "decline" };
        },
        onAskUserQuestion: async (req, ctx) => {
          if (!askUserQuestionHandler) {
            return { outcome: "skip_interview" };
          }
          return askUserQuestionHandler(req, ctx);
        },
      },
    });

  // Keep hooks live when handlers are set after construction.
  const refreshHooks = () => {
    host.setHooks({
      onPermissionRequest: async (req, ctx) => {
        if (permissionHandler) return permissionHandler(req, ctx);
        return { outcome: "reject_once" };
      },
      onElicitationRequest: async (req, ctx) => {
        if (elicitationHandler) return elicitationHandler(req, ctx);
        return { action: "decline" };
      },
      onAskUserQuestion: async (req, ctx) => {
        if (!askUserQuestionHandler) return { outcome: "skip_interview" };
        return askUserQuestionHandler(req, ctx);
      },
    });
  };

  const sessionKeyOf = (id: SessionIdentity) => `${id.repo}/${id.name}`;

  return {
    setPermissionHandler(handler) {
      permissionHandler = handler;
      refreshHooks();
    },
    setElicitationHandler(handler) {
      elicitationHandler = handler;
      refreshHooks();
    },
    setAskUserQuestionHandler(handler) {
      askUserQuestionHandler = handler;
      refreshHooks();
    },

    async cancelTurn(sessionKey, reason) {
      abortBySession.get(sessionKey)?.abort();
      abortBySession.delete(sessionKey);
      await host.cancel(sessionKey, reason);
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

      const agent =
        identity.agent ?? options.config.defaultAgent ?? "grok-build";

      log.info("ensureSession", { sessionKey: key, agent, cwd });
      try {
        const hs = await host.ensureSession({
          sessionKey: key,
          agent,
          cwd,
        });
        if (options.forceReadOnly && host.setMode) {
          const modes = host.getAvailableModes?.(key) ?? [];
          const modeId = pickSessionModeId(modes, { forceReadOnly: true });
          if (modeId) await host.setMode(key, modeId);
        }
        const resolvedIdentity = { ...identity, agent };
        handles.set(key, {
          identity: resolvedIdentity,
          cwd,
          agentSessionId: hs.agentSessionId,
        });
        log.info("ensureSession ok", {
          sessionKey: key,
          agentSessionId: hs.agentSessionId,
        });
        return {
          sessionKey: key,
          identity: resolvedIdentity,
          cwd,
        };
      } catch (err) {
        log.error("ensureSession failed", {
          sessionKey: key,
          agent,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },

    async runPromptTurn(
      handle: AgentSessionHandle,
      input: PromptTurnInput,
    ): Promise<PromptTurn> {
      if (!handles.get(handle.sessionKey)) {
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

      log.info("startTurn", {
        sessionKey: handle.sessionKey,
        requestId,
        promptLen: input.text.length,
        attachments: input.attachments?.length ?? 0,
        backend: "acp-sdk",
      });

      const turn = host.startTurn({
        sessionKey: handle.sessionKey,
        text: input.text,
        signal: ac.signal,
        ...(input.attachments && input.attachments.length > 0
          ? {
              attachments: input.attachments.map((a) => ({
                mediaType: a.mediaType,
                data: a.data,
              })),
            }
          : {}),
      });

      const events = (async function* (): AsyncGenerator<AcpTurnEvent> {
        yield { type: "turn_started" };
        let textChars = 0;
        let toolCalls = 0;
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
                thoughtBuf += piece;
                flushThought(false);
              } else {
                textChars += piece.length;
                outBuf += piece;
                flushOut(false);
                yield { type: "agent_message_chunk", text: piece };
              }
            } else if (ev.type === "tool_call") {
              toolCalls += 1;
              flushOut(true);
              flushThought(true);
              log.info("agent tool", {
                sessionKey: sk,
                toolCallId: ev.toolCallId,
                title: ev.title ? previewText(String(ev.title), 200) : undefined,
                input: summarizeJson(ev.rawInput, 300),
              });
              yield {
                type: "tool_call",
                toolCallId: String(ev.toolCallId ?? ""),
                ...(typeof ev.title === "string" ? { title: ev.title } : {}),
                ...(ev.rawInput !== undefined
                  ? { rawInput: ev.rawInput }
                  : {}),
              };
            } else if (ev.type === "error") {
              flushOut(true);
              flushThought(true);
              log.error("acp error event", {
                sessionKey: sk,
                message: ev.message,
              });
              yield { type: "process_died", error: ev.message };
            } else if (ev.type === "done") {
              flushOut(true);
              flushThought(true);
              yield {
                type: "turn_ended",
                stopReason: ev.stopReason ?? "end_turn",
              };
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
            toolCalls,
          });
          if (result.status === "failed") {
            yield {
              type: "process_died",
              error: result.error?.message ?? "turn failed",
            };
          }
        } catch (err) {
          flushOut(true);
          flushThought(true);
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
