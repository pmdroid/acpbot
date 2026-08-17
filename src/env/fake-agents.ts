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
} from "./types";
import type {
  ComputerFrameEvent,
  ComputerGrantWire,
  ComputerProbe,
} from "../acp-host/protocol";
import { STUB_COMPUTER_PROBE } from "../acp-host/protocol";

export type ScriptedTurn = {
  events: AcpTurnEvent[];
  stopReason?: string;
  /** If set, the turn hangs until this promise resolves (for permission tests). */
  hold?: Promise<void>;
  /** If true, simulate process death mid-turn. */
  die?: boolean | string;
};

export type FakeAgentsOptions = {
  /** Map repo key → cwd. Required for ensureSession. */
  repos?: Record<string, string>;
  /** Scripted turns dequeued per sessionKey. */
  scripts?: Map<string, ScriptedTurn[]>;
  /**
   * When true, record whether timeoutMs was passed on any turn.
   * Used to assert the core never sets it.
   */
  trackTimeoutMs?: boolean;
};

/**
 * Agent double: scripted ACP event streams, no real child processes.
 * Permission requests can be raised on command and left pending.
 */
export function fakeAgents(options: FakeAgentsOptions = {}): AgentsPort & {
  sessions: Map<string, AgentSessionHandle>;
  turns: Array<{ handle: AgentSessionHandle; input: PromptTurnInput }>;
  /** True if any runPromptTurn received a timeoutMs field. */
  sawTimeoutMs: boolean;
  /** Queue a scripted turn for a session key (repo/name). */
  queueTurn(sessionKey: string, script: ScriptedTurn): void;
  /** Raise a permission request against the registered handler. */
  raisePermission(
    req: PermissionRequest,
  ): Promise<PermissionDecision | undefined>;
  raiseElicitation(
    req: ElicitationRequest,
  ): Promise<ElicitationDecision | undefined>;
  raiseAskUserQuestion(req: {
    sessionId: string;
    raw: unknown;
  }): Promise<Record<string, unknown>>;
  /** Mode last set for a session (for safety assertions). */
  modes: Map<string, string>;
  setMode(sessionKey: string, modeId: string): void;
  /** Model config value per session (for /model tests). */
  models: Map<string, string>;
  /** Effort config value per session (for /effort tests). */
  efforts: Map<string, string>;
  /** Record of ensureSession calls. */
  ensureCalls: SessionIdentity[];
  /** ensureSession opts flags (parallel to ensureCalls). */
  ensureOpts: Array<{
    forceRespawn?: boolean;
    forceNewSession?: boolean;
    computerAllowed?: boolean;
  }>;
  computerGrantCalls: Array<{ sessionKey: string; grant: ComputerGrantWire }>;
  computerAbortCalls: Array<{ sessionKey: string; hostId?: string }>;
  computerFrameAckCalls: Array<{ sessionKey: string; frameId: string }>;
  /** Throw this message from computerGrant (e.g. "unknown type"). */
  computerGrantError?: string;
  computerFrameHandler?: (frame: ComputerFrameEvent) => void;
  computerStatusHandler?: (status: { sessionKey: string; text: string }) => void;
  raiseComputerFrame(frame: ComputerFrameEvent): void;
  raiseComputerStatus(status: { sessionKey: string; text: string }): void;
} {
  const sessions = new Map<string, AgentSessionHandle>();
  const turns: Array<{ handle: AgentSessionHandle; input: PromptTurnInput }> =
    [];
  const scripts = options.scripts ?? new Map<string, ScriptedTurn[]>();
  const modes = new Map<string, string>();
  const models = new Map<string, string>();
  const efforts = new Map<string, string>();
  const ensureCalls: SessionIdentity[] = [];
  const ensureOpts: Array<{
    forceRespawn?: boolean;
    forceNewSession?: boolean;
    computerAllowed?: boolean;
  }> = [];
  const abortBySession = new Map<string, AbortController>();
  let sawTimeoutMs = false;
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

  const port: AgentsPort & {
    sessions: Map<string, AgentSessionHandle>;
    turns: Array<{ handle: AgentSessionHandle; input: PromptTurnInput }>;
    sawTimeoutMs: boolean;
    queueTurn(sessionKey: string, script: ScriptedTurn): void;
    raisePermission(
      req: PermissionRequest,
    ): Promise<PermissionDecision | undefined>;
    raiseElicitation(
      req: ElicitationRequest,
    ): Promise<ElicitationDecision | undefined>;
    raiseAskUserQuestion(req: {
      sessionId: string;
      raw: unknown;
    }): Promise<Record<string, unknown>>;
    modes: Map<string, string>;
    models: Map<string, string>;
    efforts: Map<string, string>;
    setMode(sessionKey: string, modeId: string): void;
    ensureCalls: SessionIdentity[];
    ensureOpts: Array<{
      forceRespawn?: boolean;
      forceNewSession?: boolean;
      computerAllowed?: boolean;
    }>;
    computerGrantCalls: Array<{ sessionKey: string; grant: ComputerGrantWire }>;
    computerAbortCalls: Array<{ sessionKey: string; hostId?: string }>;
    computerFrameAckCalls: Array<{ sessionKey: string; frameId: string }>;
    computerGrantError?: string;
    computerFrameHandler?: (frame: ComputerFrameEvent) => void;
    computerStatusHandler?: (status: { sessionKey: string; text: string }) => void;
    raiseComputerFrame(frame: ComputerFrameEvent): void;
    raiseComputerStatus(status: { sessionKey: string; text: string }): void;
  } = {
    sessions,
    turns,
    get sawTimeoutMs() {
      return sawTimeoutMs;
    },
    modes,
    models,
    efforts,
    ensureCalls,
    ensureOpts,
    computerGrantCalls: [],
    computerAbortCalls: [],
    computerFrameAckCalls: [],

    raiseComputerFrame(frame) {
      port.computerFrameHandler?.(frame);
    },
    raiseComputerStatus(status) {
      port.computerStatusHandler?.(status);
    },

    queueTurn(sessionKey, script) {
      const list = scripts.get(sessionKey) ?? [];
      list.push(script);
      scripts.set(sessionKey, list);
    },

    setMode(sessionKey, modeId) {
      modes.set(sessionKey, modeId);
    },

    async raisePermission(req) {
      if (!permissionHandler) return undefined;
      const ac = abortBySession.get(req.sessionId) ?? new AbortController();
      return permissionHandler(req, { signal: ac.signal });
    },

    async raiseElicitation(req) {
      if (!elicitationHandler) return undefined;
      const ac = abortBySession.get(req.sessionId) ?? new AbortController();
      return elicitationHandler(req, { signal: ac.signal });
    },

    setPermissionHandler(handler) {
      permissionHandler = handler;
    },

    setElicitationHandler(handler) {
      elicitationHandler = handler;
    },

    setAskUserQuestionHandler(handler) {
      askUserQuestionHandler = handler;
    },

    setComputerFrameHandler(handler) {
      port.computerFrameHandler = handler;
    },
    setComputerStatusHandler(handler) {
      port.computerStatusHandler = handler;
    },

    async computerGrant(input) {
      port.computerGrantCalls.push({
        sessionKey: input.sessionKey,
        grant: input.grant,
      });
      if (port.computerGrantError) {
        throw new Error(port.computerGrantError);
      }
      return { probe: STUB_COMPUTER_PROBE satisfies ComputerProbe };
    },

    async computerAbort(sessionKey, opts) {
      port.computerAbortCalls.push({
        sessionKey,
        ...(opts?.hostId ? { hostId: opts.hostId } : {}),
      });
    },

    computerFrameAck(sessionKey, frameId) {
      port.computerFrameAckCalls.push({ sessionKey, frameId });
    },

    async raiseAskUserQuestion(req) {
      if (!askUserQuestionHandler) return { outcome: "skip_interview" };
      const ac = abortBySession.get(req.sessionId) ?? new AbortController();
      return askUserQuestionHandler(req, { signal: ac.signal });
    },

    async cancelTurn(sessionKey) {
      const ac = abortBySession.get(sessionKey);
      ac?.abort();
      abortBySession.delete(sessionKey);
    },

    async setSessionMode(sessionKey, modeId) {
      modes.set(sessionKey, modeId);
      return {
        currentModeId: modeId,
        availableModeIds: ["plan", "build", "default"],
      };
    },

    async getSessionMode(sessionKey) {
      return {
        currentModeId: modes.get(sessionKey) ?? "build",
        availableModeIds: ["plan", "build", "default"],
      };
    },

    async getSessionConfigOptions(sessionKey) {
      const cur = models.get(sessionKey) ?? "fast";
      const effort = efforts.get(sessionKey) ?? "high";
      return [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: cur,
          options: [
            { value: "fast", name: "Fast" },
            { value: "smart", name: "Smart" },
          ],
        },
        {
          id: "effort",
          name: "Effort",
          type: "select",
          category: "effort",
          currentValue: effort,
          options: [
            { value: "high", name: "high" },
            { value: "medium", name: "medium" },
            { value: "low", name: "low" },
          ],
        },
      ];
    },

    async setSessionConfigOption(sessionKey, configId, value) {
      if (configId === "model" && typeof value === "string") {
        models.set(sessionKey, value);
      }
      if (configId === "effort" && typeof value === "string") {
        efforts.set(sessionKey, value);
      }
      return port.getSessionConfigOptions!(sessionKey);
    },

    async switchSessionAgent(identity, agentId) {
      const key = sessionKeyOf(identity);
      const repos = options.repos ?? {};
      const cwd = repos[identity.repo];
      if (!cwd) {
        throw new Error(`unknown repo "${identity.repo}"`);
      }
      const resolved = { ...identity, agent: agentId };
      ensureCalls.push({ ...resolved });
      const handle: AgentSessionHandle = {
        sessionKey: key,
        identity: resolved,
        cwd,
      };
      sessions.set(key, handle);
      modes.set(key, "read-only");
      models.set(key, "fast");
      efforts.set(key, "high");
      return handle;
    },

    async ensureSession(identity, opts) {
      ensureCalls.push({ ...identity });
      ensureOpts.push({
        ...(opts?.forceRespawn ? { forceRespawn: true } : {}),
        ...(opts?.forceNewSession ? { forceNewSession: true } : {}),
        ...(opts?.computerAllowed !== undefined
          ? { computerAllowed: opts.computerAllowed === true }
          : {}),
      });
      const key = sessionKeyOf(identity);
      const existing = sessions.get(key);
      if (
        existing &&
        existing.identity.agent === identity.agent &&
        !opts?.forceNewSession &&
        !opts?.forceRespawn
      ) {
        return existing;
      }

      const repos = options.repos ?? {};
      const cwd = opts?.cwd?.trim() || repos[identity.repo];
      if (!cwd) {
        throw new Error(
          `unknown repo "${identity.repo}" — configure it before creating a session`,
        );
      }

      const handle: AgentSessionHandle = {
        sessionKey: key,
        identity: { ...identity },
        cwd,
      };
      sessions.set(key, handle);
      // Simulate read-only mode being applied immediately after create.
      modes.set(key, "read-only");
      if (!models.has(key) || opts?.forceNewSession) models.set(key, "fast");
      if (!efforts.has(key) || opts?.forceNewSession) efforts.set(key, "high");
      return handle;
    },

    async runPromptTurn(handle, input): Promise<PromptTurn> {
      // Detect if caller passed timeoutMs (should never happen).
      if (
        input !== null &&
        typeof input === "object" &&
        "timeoutMs" in (input as object)
      ) {
        sawTimeoutMs = true;
      }
      turns.push({ handle, input });

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

      const queue = scripts.get(handle.sessionKey) ?? [];
      const script = queue.shift() ?? {
        events: [
          { type: "turn_started" as const },
          { type: "turn_ended" as const, stopReason: "end_turn" },
        ],
        stopReason: "end_turn",
      };

      const events = (async function* () {
        if (ac.signal.aborted) {
          yield { type: "turn_ended" as const, stopReason: "cancelled" };
          return;
        }
        if (script.hold) {
          await Promise.race([
            script.hold,
            new Promise<void>((resolve) => {
              ac.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            }),
          ]);
          if (ac.signal.aborted) {
            yield { type: "turn_ended" as const, stopReason: "cancelled" };
            return;
          }
        }
        for (const ev of script.events) {
          if (ac.signal.aborted) {
            yield { type: "turn_ended" as const, stopReason: "cancelled" };
            return;
          }
          yield ev;
        }
        if (script.die) {
          yield {
            type: "process_died" as const,
            error:
              typeof script.die === "string" ? script.die : "agent process died",
          };
        }
      })();

      const done = (async () => {
        if (script.hold) {
          await Promise.race([
            script.hold,
            new Promise<void>((resolve) => {
              ac.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            }),
          ]);
        }
        if (ac.signal.aborted) {
          return { stopReason: "cancelled" };
        }
        if (script.die) {
          throw new Error(
            typeof script.die === "string" ? script.die : "agent process died",
          );
        }
        return { stopReason: script.stopReason ?? "end_turn" };
      })().finally(() => {
        abortBySession.delete(handle.sessionKey);
      });

      return { events, done };
    },
  };

  return port;
}
