/**
 * ACP host server: owns agent stdio processes across worker reconnects.
 * Also ticks in-repo schedules (see scheduler.ts) into session slots.
 */
import { createServer, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import type { AcpbotConfig } from "../env/types";
import {
  createSessionHost,
  type SessionHost,
  type SessionHostHooks,
} from "../acp/session-host";
import type { HostSessionStore } from "../acp/session-store";
import {
  type HostToWorker,
  type WorkerToHost,
  defaultAcpHostSock,
} from "./protocol";
import { createFakeComputerBackend } from "../computer/fake";
import { createComputerSupervisor } from "../computer/supervisor";
import {
  createHostApiServer,
  hostApiSockPath,
  mintHostApiToken,
} from "./host-api";
import {
  parseReposFromEnv,
  scheduleTickMs,
  startSchedulerLoop,
  type FireJobResult,
  type SchedulerLoopHandle,
} from "./scheduler";
import {
  createHostEveService,
  bindHostEveRuntimeDeps,
  markEveAbort,
} from "../eve/host-runner";
import {
  isPlanExitPermission,
  isComputerUsePermission,
  shouldForceAskPermission,
} from "../acp/permission-map";


/** Site 2 (acp-host hooks): bypass never auto-allows plan-exit or computer-use. */
export function acpHostAutoAllowsPermission(
  permissionMode: "ask" | "bypass" | undefined,
  raw: unknown,
): boolean {
  return permissionMode === "bypass" && !shouldForceAskPermission(raw);
}

type QueuedHostPrompt = {
  sock: HostConn;
  msg: Extract<WorkerToHost, { type: "prompt" }>;
};

type Slot = {
  slotKey: string;
  agent: string;
  cwd: string;
  /** Tool-permission policy for this slot (from ensure config). */
  permissionMode?: "ask" | "bypass";
  host: SessionHost;
  agentSessionId: string | null;
  owner: HostConn | null;
  busy: boolean;
  /** FIFO prompts while a turn is in flight (worker waits for prompt_ok/err). */
  promptQueue: QueuedHostPrompt[];
  permissionResolvers: Map<
    string,
    (d: import("../env/types").PermissionDecision | undefined) => void
  >;
  elicitationResolvers: Map<
    string,
    (d: import("../env/types").ElicitationDecision | undefined) => void
  >;
  askResolvers: Map<string, (r: Record<string, unknown>) => void>;
  computerAllowed?: boolean;
  hostApiToken?: string;
  turnSource?: "operator" | "schedule" | "eve";
  turnAbort?: AbortController;
};

export type AcpHostServerOptions = {
  sockPath?: string;
  stateDir?: string;
  config?: AcpbotConfig;
  sessionStore?: HostSessionStore;
  log?: Logger;
  /**
   * Catalog of repos to scan for schedules. Default: config.repos or ACPBOT_REPOS_JSON.
   * Pass `{}` to disable the scheduler.
   */
  repos?: Record<string, string>;
  /** Default agent when ensuring a cold slot for a schedule fire. */
  defaultAgent?: string;
  /** Schedule tick interval ms. Default: ACPBOT_SCHEDULE_TICK_MS or 20s. */
  scheduleTickMs?: number;
  /** Disable schedule loop (tests that only need the socket). */
  enableScheduler?: boolean;
  /** Test seam: skip agent spawn (supervisor / schedule-source tests). */
  testSessionHost?: SessionHost;
  /**
   * Optional remote WebSocket listen (authenticated). When set, host accepts
   * WSS/WS workers in addition to the Unix socket. Token is required.
   */
  remoteListen?: {
    port: number;
    host?: string;
    token: string;
    /** When true (default in prod callers), only wss with tls. Tests use ws. */
    tls?: { cert: string | Buffer; key: string | Buffer };
  };
};

/** Line-oriented endpoint (Unix socket or WebSocket adapter). */
export type HostConn = {
  destroyed: boolean;
  write(data: string): void;
};

function send(sock: HostConn, msg: HostToWorker): void {
  if (sock.destroyed) return;
  sock.write(`${JSON.stringify(msg)}\n`);
}

function asHostConn(sock: Socket): HostConn {
  return {
    get destroyed() {
      return sock.destroyed;
    },
    write(data: string) {
      sock.write(data);
    },
  };
}

export async function startAcpHostServer(
  options: AcpHostServerOptions = {},
): Promise<{
  sockPath: string;
  close: () => Promise<void>;
  /** Drop live slots for a repo so MCP rebuilds with new OAuth tokens. */
  dropSlotsForRepo: (repoKey: string) => Promise<number>;
  /** Exposed for tests — run one schedule tick. */
  scheduleTickNow?: () => Promise<import("./scheduler").TickResult>;
  /** Mutable repos catalog (scheduler + hot-reload). */
  repos?: Record<string, string>;
  remotePort?: number;
  hostApiSockPath?: string;
  config?: AcpbotConfig;
  fireScheduledPrompt: (args: {
    sessionKey: string;
    repoRoot: string;
    text: string;
  }) => Promise<FireJobResult>;
  computerAct: (
    sessionKey: string,
    action: import("../computer/supervisor").ComputerAction,
  ) => Promise<import("../computer/supervisor").ComputerActionResult>;
  onComputerConfigReloaded: () => void;
  /** Test seam: attach a dummy slot without spawning an agent. */
  attachTestSlot: (slot: {
    slotKey: string;
    computerAllowed?: boolean;
    hostApiToken?: string;
    owner?: HostConn | null;
  }) => void;
  setTurnSource: (
    slotKey: string,
    source: Slot["turnSource"],
  ) => void;
}> {
  const log = (options.log ?? silentLogger()).child("acp-host");
  const stateDir =
    options.stateDir ??
    process.env.ACPBOT_STATE_DIR?.trim() ??
    "./data/acpbot-state";
  const sockPath = options.sockPath ?? defaultAcpHostSock(stateDir);
  const baseConfig: AcpbotConfig = options.config ?? {
    operatorUserId: 0,
    mcpEnabled: true,
  };
  const defaultAgent =
    options.defaultAgent?.trim() ||
    baseConfig.defaultAgent?.trim() ||
    process.env.ACPBOT_DEFAULT_AGENT?.trim() ||
    "grok-build";
  // Mutable catalog — hot reload mutates this object in place so the
  // scheduler picks up new [repos] without restart.
  const repos: Record<string, string> = {
    ...(options.repos ??
      baseConfig.repos ??
      parseReposFromEnv(process.env)),
  };
  // Keep baseConfig.repos as the same map for any code reading config.repos
  baseConfig.repos = repos;

  const slots = new Map<string, Slot>();
  let scheduler: SchedulerLoopHandle | null = null;
  const hostApiPath = hostApiSockPath(stateDir);

  const computer = createComputerSupervisor({
    backend: createFakeComputerBackend(),
    getConfig: () => baseConfig.computer,
    getSlot: (slotKey) => {
      const s = slots.get(slotKey);
      if (!s) return undefined;
      return {
        slotKey,
        owner: s.owner,
        computerAllowed: s.computerAllowed,
        turnSource: s.turnSource,
        turnAbort: s.turnAbort?.signal,
      };
    },
    publishFrame: (frame) => {
      const slot = slots.get(frame.sessionKey);
      if (slot?.owner && !slot.owner.destroyed) {
        send(slot.owner, { type: "computer_frame", ...frame });
      }
    },
    log,
    stateDir,
  });

  const hostApi = createHostApiServer({
    supervisor: computer,
    auth: {
      tokenFor: (sessionKey) => slots.get(sessionKey)?.hostApiToken,
    },
    sockPath: hostApiPath,
    stateDir,
    log,
  });

  function hostApiMcpEnv(token: string): Array<{ name: string; value: string }> {
    return [
      { name: "ACPBOT_HOST_API_TOKEN", value: token },
      { name: "ACPBOT_HOST_API_SOCK", value: hostApiPath },
    ];
  }

  function applyComputerAllowed(
    slot: Slot,
    config: { computerAllowed?: boolean },
  ): void {
    if ("computerAllowed" in config && config.computerAllowed !== undefined) {
      slot.computerAllowed = config.computerAllowed === true;
    }
  }

  function newSessionHost(slotKey: string): SessionHost {
    if (options.testSessionHost) return options.testSessionHost;
    return createSessionHost({
      config: {
        ...baseConfig,
      },
      stateDir,
      ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
      log,
      hooks: makeHooks(slotKey),
    });
  }

  function makeHooks(slotKey: string): SessionHostHooks {
    return {
      onPermissionRequest: async (req, ctx) => {
        const slot = slots.get(slotKey);
        // Never auto-approve leaving plan mode — operator must click.
        if (acpHostAutoAllowsPermission(slot?.permissionMode, req.raw)) {
          log.info("permission auto-approved (bypass)", {
            slotKey,
            toolCallId: req.toolCallId,
          });
          return { outcome: "allow_always" };
        }
        if (isPlanExitPermission(req.raw) || isComputerUsePermission(req.raw)) {
          log.info(
            isComputerUsePermission(req.raw)
              ? "computer-use permission → worker (forced ask)"
              : "plan-exit permission → worker (forced ask)",
            {
              slotKey,
              toolCallId: req.toolCallId,
              sessionBypass: slot?.permissionMode === "bypass",
            },
          );
        }
        if (!slot?.owner || slot.owner.destroyed) {
          log.warn("permission fail-closed (no worker)", { slotKey });
          return { outcome: "reject_once" };
        }
        const permissionReqId = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return await new Promise((resolve) => {
          const timer = setTimeout(() => {
            slot.permissionResolvers.delete(permissionReqId);
            resolve({ outcome: "cancel" });
          }, 300_000);
          const onAbort = () => {
            clearTimeout(timer);
            slot.permissionResolvers.delete(permissionReqId);
            resolve({ outcome: "cancel" });
          };
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          slot.permissionResolvers.set(permissionReqId, (d) => {
            clearTimeout(timer);
            ctx.signal.removeEventListener("abort", onAbort);
            resolve(d);
          });
          send(slot.owner!, {
            type: "permission",
            reqId: permissionReqId,
            slotKey,
            permissionReqId,
            sessionId: req.sessionId,
            toolCallId: req.toolCallId,
            raw: req.raw,
          });
        });
      },
      onElicitationRequest: async (req, ctx) => {
        const slot = slots.get(slotKey);
        if (!slot?.owner || slot.owner.destroyed) {
          return { action: "decline" };
        }
        const elicitationReqId = `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return await new Promise((resolve) => {
          const timer = setTimeout(() => {
            slot.elicitationResolvers.delete(elicitationReqId);
            resolve({ action: "cancel" });
          }, 300_000);
          const onAbort = () => {
            clearTimeout(timer);
            slot.elicitationResolvers.delete(elicitationReqId);
            resolve({ action: "cancel" });
          };
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          slot.elicitationResolvers.set(elicitationReqId, (d) => {
            clearTimeout(timer);
            ctx.signal.removeEventListener("abort", onAbort);
            resolve(d);
          });
          send(slot.owner!, {
            type: "elicitation",
            reqId: elicitationReqId,
            slotKey,
            elicitationReqId,
            sessionId: req.sessionId,
            raw: req.raw,
          });
        });
      },
      onAskUserQuestion: async (req, ctx) => {
        const slot = slots.get(slotKey);
        if (!slot?.owner || slot.owner.destroyed) {
          return { outcome: "skip_interview" };
        }
        const askReqId = `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return await new Promise((resolve) => {
          const timer = setTimeout(() => {
            slot.askResolvers.delete(askReqId);
            resolve({ outcome: "skip_interview" });
          }, 300_000);
          const onAbort = () => {
            clearTimeout(timer);
            slot.askResolvers.delete(askReqId);
            resolve({ outcome: "skip_interview" });
          };
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          slot.askResolvers.set(askReqId, (r) => {
            clearTimeout(timer);
            ctx.signal.removeEventListener("abort", onAbort);
            resolve(r);
          });
          send(slot.owner!, {
            type: "ask_user_question",
            reqId: askReqId,
            slotKey,
            askReqId,
            sessionId: req.sessionId,
            raw: req.raw,
          });
        });
      },
    };
  }

  /**
   * Drop live agent slots for a repo so the next ensure rebuilds MCP with
   * fresh OAuth tokens (after /mcp auth callback).
   */
  async function dropSlotsForRepo(repoKey: string): Promise<number> {
    const key = repoKey.trim();
    if (!key) return 0;
    const prefix = `${key}/`;
    let n = 0;
    for (const [slotKey, slot] of [...slots.entries()]) {
      if (slotKey !== key && !slotKey.startsWith(prefix)) continue;
      try {
        await slot.host.dispose();
      } catch {
        /* */
      }
      slots.delete(slotKey);
      n++;
      log.info("dropped slot after OAuth (MCP will rebuild on next ensure)", {
        slotKey,
        repoKey: key,
      });
    }
    return n;
  }

  /**
   * Coalesce concurrent ensure for the same slotKey. Without this, a worker
   * timeout + retry spawns a *second* Grok while the first is still on
   * session/load — both contend on the same agentSessionId and hang.
   */
  const ensureInflight = new Map<string, Promise<void>>();

  async function ensureSlot(
    sock: Socket,
    msg: Extract<WorkerToHost, { type: "ensure" }>,
  ): Promise<void> {
    const { slotKey } = msg;
    const prev = ensureInflight.get(slotKey);
    if (prev) {
      log.info("ensure waiting for in-flight ensure", { slotKey });
      try {
        await prev;
      } catch {
        /* first ensure failed — fall through and retry */
      }
    }

    const work = ensureSlotBody(sock, msg).finally(() => {
      if (ensureInflight.get(slotKey) === work) {
        ensureInflight.delete(slotKey);
      }
    });
    ensureInflight.set(slotKey, work);
    await work;
  }

  async function ensureSlotBody(
    sock: Socket,
    msg: Extract<WorkerToHost, { type: "ensure" }>,
  ): Promise<void> {
    const { slotKey, config } = msg;
    let slot = slots.get(slotKey);

    // Post-OAuth or operator /fresh: force kill so we respawn cleanly.
    if (slot && (config.forceRespawn || config.forceNewSession)) {
      log.info(
        config.forceNewSession ? "ensure forceNewSession" : "ensure forceRespawn",
        { slotKey },
      );
      try {
        await slot.host.dispose();
      } catch {
        /* */
      }
      slots.delete(slotKey);
      slot = undefined;
    }

    // Reattach: same agent+cwd, prefer resume if agentSessionId matches or any live
    if (slot) {
      const same =
        slot.agent === config.agent &&
        slot.cwd === config.cwd &&
        (slot.permissionMode ?? "ask") === (config.permissionMode ?? "ask");
      if (same) {
        slot.owner = sock;
        applyComputerAllowed(slot, config);
        try {
          const hs = await slot.host.ensureSession({
            sessionKey: slotKey,
            agent: config.agent,
            cwd: config.cwd,
            ...(config.permissionMode
              ? { permissionMode: config.permissionMode }
              : {}),
            ...(config.forceRespawn ? { forceRespawn: true } : {}),
            ...(config.forceNewSession ? { forceNewSession: true } : {}),
          });
          slot.agentSessionId = hs.agentSessionId;
          const mode = await slot.host.getModeState(slotKey);
          send(sock, {
            type: "ensure_ok",
            reqId: msg.reqId,
            slotKey,
            agentSessionId: hs.agentSessionId,
            wasNew: Boolean(config.forceNewSession),
            ...(mode?.currentModeId
              ? { currentModeId: mode.currentModeId }
              : {}),
            availableModeIds: mode?.availableModeIds ?? [],
          });
          log.info("reattach", {
            slotKey,
            agentSessionId: hs.agentSessionId,
          });
          return;
        } catch (err) {
          log.warn("reattach failed; recreating", {
            slotKey,
            error: err instanceof Error ? err.message : String(err),
          });
          try {
            await slot.host.dispose();
          } catch {
            /* */
          }
          slots.delete(slotKey);
          slot = undefined;
        }
      } else {
        // Different agent/cwd — kill old
        try {
          await slot.host.dispose();
        } catch {
          /* */
        }
        slots.delete(slotKey);
        slot = undefined;
      }
    }

    const host = options.testSessionHost
      ? options.testSessionHost
      : createSessionHost({
          config: {
            ...baseConfig,
            ...(config.mcpEnabled !== undefined
              ? { mcpEnabled: config.mcpEnabled }
              : {}),
          },
          stateDir,
          ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
          log,
          hooks: makeHooks(slotKey),
        });
    const hostApiToken = mintHostApiToken();

    try {
      // Resume via durable store is inside createSessionHost using sessionKey
      // (skipped when forceNewSession deletes the prior record first).
      const hs = await host.ensureSession({
        sessionKey: slotKey,
        agent: config.agent,
        cwd: config.cwd,
        ...(config.permissionMode
          ? { permissionMode: config.permissionMode }
          : {}),
        ...(config.forceNewSession ? { forceNewSession: true } : {}),
        mcpEnv: hostApiMcpEnv(hostApiToken),
      });
      const mode = await host.getModeState(slotKey);
      slots.set(slotKey, {
        slotKey,
        agent: config.agent,
        cwd: config.cwd,
        ...(config.permissionMode
          ? { permissionMode: config.permissionMode }
          : {}),
        host,
        agentSessionId: hs.agentSessionId,
        owner: sock,
        busy: false,
        promptQueue: [],
        permissionResolvers: new Map(),
        elicitationResolvers: new Map(),
        askResolvers: new Map(),
        hostApiToken,
        computerAllowed: config.computerAllowed === true,
      });
      send(sock, {
        type: "ensure_ok",
        reqId: msg.reqId,
        slotKey,
        agentSessionId: hs.agentSessionId,
        wasNew: true,
        ...(mode?.currentModeId ? { currentModeId: mode.currentModeId } : {}),
        availableModeIds: mode?.availableModeIds ?? [],
      });
      log.info("ensure new/load", {
        slotKey,
        agent: config.agent,
        agentSessionId: hs.agentSessionId,
      });
    } catch (err) {
      try {
        await host.dispose();
      } catch {
        /* */
      }
      send(sock, {
        type: "err",
        reqId: msg.reqId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handlePrompt(
    sock: Socket,
    msg: Extract<WorkerToHost, { type: "prompt" }>,
  ): Promise<void> {
    const slot = slots.get(msg.slotKey);
    if (!slot) {
      send(sock, {
        type: "prompt_err",
        reqId: msg.reqId,
        slotKey: msg.slotKey,
        error: `no slot ${msg.slotKey} — call ensure first`,
      });
      return;
    }
    // FIFO while a turn is running — worker awaits prompt_ok/err for this reqId.
    if (slot.busy) {
      slot.promptQueue.push({ sock, msg });
      log.info("prompt queued (slot busy)", {
        slotKey: msg.slotKey,
        depth: slot.promptQueue.length,
        reqId: msg.reqId,
      });
      return;
    }
    await runHostPrompt(slot, sock, msg);
  }

  async function runHostPrompt(
    slot: Slot,
    sock: Socket,
    msg: Extract<WorkerToHost, { type: "prompt" }>,
  ): Promise<void> {
    slot.owner = sock;
    slot.busy = true;
    slot.turnSource = msg.source ?? "operator";
    slot.turnAbort = new AbortController();
    computer.onTurnStart(slot.slotKey);
    try {
      const turn = slot.host.startTurn({
        sessionKey: msg.slotKey,
        text: msg.text,
        ...(msg.attachments ? { attachments: msg.attachments } : {}),
        ...(msg.source ? { source: msg.source } : {}),
      });
      for await (const event of turn.events) {
        if (slot.owner && !slot.owner.destroyed) {
          send(slot.owner, {
            type: "turn_event",
            reqId: msg.reqId,
            slotKey: msg.slotKey,
            event,
          });
        }
      }
      const result = await turn.result;
      if (slot.owner && !slot.owner.destroyed) {
        send(slot.owner, {
          type: "prompt_ok",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
          status: result.status,
          ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        });
      }
    } catch (err) {
      if (slot.owner && !slot.owner.destroyed) {
        send(slot.owner, {
          type: "prompt_err",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      slot.busy = false;
      slot.turnSource = undefined;
      slot.turnAbort = undefined;
      // Drain next queued prompt (if any) for this slot.
      const next = slot.promptQueue.shift();
      if (next) {
        log.info("prompt dequeued", {
          slotKey: slot.slotKey,
          remaining: slot.promptQueue.length,
          reqId: next.msg.reqId,
        });
        // Don't await — keep handlePrompt stack shallow; next turn owns busy flag.
        void runHostPrompt(slot, next.sock, next.msg);
      }
    }
  }

  /**
   * Ensure a slot without a worker socket (scheduled fires).
   * Reuses existing slot when agent+cwd match; otherwise recreates.
   */
  async function ensureSlotForSchedule(args: {
    slotKey: string;
    agent: string;
    cwd: string;
    /**
     * Tool policy for unattended slots (schedules / EVE leaves).
     * Default: config `permission_mode`, else ask.
     * EVE leaves should pass `bypass` so they are not fail-closed without a
     * human answering Telegram permission prompts.
     */
    permissionMode?: "ask" | "bypass";
  }): Promise<Slot> {
    const { slotKey, agent, cwd } = args;
    const permissionMode =
      args.permissionMode ?? baseConfig.permissionMode ?? "ask";
    let slot = slots.get(slotKey);

    if (slot) {
      const same =
        slot.agent === agent &&
        slot.cwd === cwd &&
        (slot.permissionMode ?? "ask") === permissionMode;
      if (same) {
        try {
          const hs = await slot.host.ensureSession({
            sessionKey: slotKey,
            agent,
            cwd,
            permissionMode,
          });
          slot.agentSessionId = hs.agentSessionId;
          slot.permissionMode = permissionMode;
          return slot;
        } catch (err) {
          log.warn("schedule ensure reattach failed; recreating", {
            slotKey,
            error: err instanceof Error ? err.message : String(err),
          });
          try {
            await slot.host.dispose();
          } catch {
            /* */
          }
          slots.delete(slotKey);
          slot = undefined;
        }
      } else {
        try {
          await slot.host.dispose();
        } catch {
          /* */
        }
        slots.delete(slotKey);
        slot = undefined;
      }
    }

    const host = newSessionHost(slotKey);
    const hostApiToken = mintHostApiToken();

    try {
      const hs = await host.ensureSession({
        sessionKey: slotKey,
        agent,
        cwd,
        permissionMode,
        mcpEnv: hostApiMcpEnv(hostApiToken),
      });
      const created: Slot = {
        slotKey,
        agent,
        cwd,
        permissionMode,
        host,
        agentSessionId: hs.agentSessionId,
        owner: null,
        busy: false,
        promptQueue: [],
        permissionResolvers: new Map(),
        elicitationResolvers: new Map(),
        askResolvers: new Map(),
        hostApiToken,
        // omit computerAllowed — new schedule/EVE slots stay false
      };
      slots.set(slotKey, created);
      log.info("schedule ensure new/load", {
        slotKey,
        agent,
        agentSessionId: hs.agentSessionId,
        permissionMode,
      });
      return created;
    } catch (err) {
      try {
        await host.dispose();
      } catch {
        /* */
      }
      throw err;
    }
  }

  /**
   * Fire a scheduled prompt into a session slot (worker optional).
   * Does not require a connected worker — turn events are forwarded if owner is live.
   */
  async function fireScheduledPrompt(args: {
    sessionKey: string;
    repoRoot: string;
    text: string;
  }): Promise<FireJobResult> {
    const slotKey = args.sessionKey;
    let slot = slots.get(slotKey);

    if (slot?.busy) {
      return { status: "busy" };
    }

    // Resolve agent: existing slot → durable store → default.
    // Cold schedule fires always use catalog repoRoot as cwd (not store cwd).
    let agent = slot?.agent ?? defaultAgent;
    const cwd = slot?.cwd ?? args.repoRoot;
    if (!slot && options.sessionStore) {
      try {
        const rec = await options.sessionStore.load(slotKey);
        if (rec?.agent) {
          agent = rec.agent;
        }
      } catch {
        /* use defaults */
      }
    }

    try {
      slot = await ensureSlotForSchedule({ slotKey, agent, cwd });
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (slot.busy) {
      return { status: "busy" };
    }

    slot.busy = true;
    slot.turnSource = "schedule";
    slot.turnAbort = new AbortController();
    computer.onTurnStart(slot.slotKey);
    const reqId = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const turn = slot.host.startTurn({
        sessionKey: slotKey,
        text: args.text,
      });
      for await (const event of turn.events) {
        if (slot.owner && !slot.owner.destroyed) {
          send(slot.owner, {
            type: "turn_event",
            reqId,
            slotKey,
            event,
          });
        }
      }
      const result = await turn.result;
      if (slot.owner && !slot.owner.destroyed) {
        send(slot.owner, {
          type: "prompt_ok",
          reqId,
          slotKey,
          status: result.status,
          ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        });
      }
      // Treat agent cancel / error stop as error for lastStatus
      if (
        result.status === "error" ||
        result.status === "cancelled" ||
        result.status === "canceled"
      ) {
        return {
          status: "error",
          error: result.stopReason ?? result.status,
        };
      }
      return { status: "ok" };
    } catch (err) {
      if (slot.owner && !slot.owner.destroyed) {
        send(slot.owner, {
          type: "prompt_err",
          reqId,
          slotKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      slot.busy = false;
      slot.turnSource = undefined;
      slot.turnAbort = undefined;
    }
  }

  // ── EVE (orchestration on host; worker is control + Telegram only) ───────
  const eveOwners = new Map<string, HostConn>(); // runId → worker sock
  const eveService = createHostEveService({
    stateDir,
    eveConfig: baseConfig.eve,
    defaultAgent,
    notify: () => {},
    leaf: {
      runLeaf: async () => ({ summary: "", status: "failed" }),
    },
  });

  function startHostEveExecution(
    runId: string,
    sock: HostConn,
    resume: boolean,
  ): void {
    void (async () => {
      const run = await eveService.status(runId);
      if (!run) return;
      eveOwners.set(runId, sock);
      markEveAbort(runId, false);
      const deps = bindHostEveRuntimeDeps({
        service: eveService,
        ctx: {
          stateDir,
          eveConfig: baseConfig.eve,
          defaultAgent:
            baseConfig.eve?.defaultAgent || defaultAgent || "grok-build",
          notify: (sessionKey, text, extra) => {
            if (!sock.destroyed) {
              send(sock, {
                type: "eve_notify",
                sessionKey,
                text,
                runId: extra?.runId ?? runId,
                ...(extra?.ask ? { ask: extra.ask } : {}),
              });
            }
          },
          leaf: {
            runLeaf: async (input) => {
              // Unattended EVE leaves must bypass tool asks — no human on the
              // child topic; fail-closed ask would reject every shell/fs tool.
              const slot = await ensureSlotForSchedule({
                slotKey: input.slotKey,
                agent: input.agent,
                cwd: input.cwd,
                permissionMode: "bypass",
              });
              slot.owner = sock.destroyed ? null : sock;
              const deadline =
                Date.now() + Math.max(5_000, input.timeoutSec * 1000);
              while (slot.busy && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 500));
              }
              if (slot.busy) {
                return { summary: "slot busy timeout", status: "failed" };
              }
              slot.busy = true;
              slot.turnSource = "eve";
              slot.turnAbort = new AbortController();
              computer.onTurnStart(slot.slotKey);
              let summary = "";
              const reqId = `eve-leaf-${Date.now()}`;
              try {
                const turn = slot.host.startTurn({
                  sessionKey: input.slotKey,
                  text: input.prompt,
                });
                for await (const event of turn.events) {
                  // SessionHost maps ACP agent_message_chunk → text_delta (output).
                  if (
                    event.type === "text_delta" &&
                    typeof event.text === "string" &&
                    event.stream !== "thought"
                  ) {
                    summary += event.text;
                  }
                  if (!sock.destroyed) {
                    send(sock, {
                      type: "turn_event",
                      reqId,
                      slotKey: input.slotKey,
                      event,
                    });
                  }
                }
                const result = await turn.result;
                const status =
                  result.status === "error" ||
                  result.status === "cancelled" ||
                  result.status === "canceled"
                    ? "failed"
                    : result.status || "idle";
                return { summary: summary.trim(), status };
              } catch (err) {
                return {
                  summary: err instanceof Error ? err.message : String(err),
                  status: "failed",
                };
              } finally {
                slot.busy = false;
                slot.turnSource = undefined;
                slot.turnAbort = undefined;
                try {
                  await slot.host.dispose();
                } catch {
                  /* */
                }
                slots.delete(input.slotKey);
              }
            },
          },
        },
        parentSessionKey: run.sessionKey,
        repoRoot: run.repoRoot,
        repoKey: run.repoKey,
        owner: sock.destroyed ? null : sock,
      });
      try {
        await (resume
          ? eveService.resume(runId, deps)
          : eveService.approveAndStart(runId, deps));
        // Completion / ask / fail already notified from the runtime.
        // Do not dump formatStatus (result JSON + logs) onto the topic.
      } catch (err) {
        log.warn("EVE host run failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!sock.destroyed) {
          send(sock, {
            type: "eve_notify",
            sessionKey: run.sessionKey,
            text: `⚠️ EVE failed · ${
              err instanceof Error ? err.message : String(err)
            }`.slice(0, 400),
            runId,
          });
        }
      }
    })();
  }

  async function handleEveMsg(
    sock: HostConn,
    msg: WorkerToHost,
  ): Promise<boolean> {
    if (msg.type === "eve_run") {
      try {
        const created = await eveService.createRun({
          sessionKey: msg.sessionKey,
          repoKey: msg.repoKey,
          repoRoot: msg.repoRoot,
          name: msg.name,
          path: msg.path,
          source: msg.source,
          args: msg.args,
          skipApproval: msg.skipApproval === true,
          agentsMax: msg.agentsMax,
        });
        eveOwners.set(created.runId, sock);
        if (created.status === "pending_approval") {
          send(sock, {
            type: "eve_ok",
            reqId: msg.reqId,
            message: `pending approval: ${created.runId}`,
            runId: created.runId,
            run: created,
          });
          return true;
        }
        startHostEveExecution(created.runId, sock, false);
        send(sock, {
          type: "eve_ok",
          reqId: msg.reqId,
          message: `EVE started on host: ${created.runId}`,
          runId: created.runId,
          run: created,
        });
      } catch (err) {
        send(sock, {
          type: "err",
          reqId: msg.reqId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }
    if (msg.type === "eve_approve") {
      try {
        markEveAbort(msg.runId, false);
        eveOwners.set(msg.runId, sock);
        startHostEveExecution(msg.runId, sock, false);
        send(sock, {
          type: "eve_ok",
          reqId: msg.reqId,
          message: `EVE approve/start on host: ${msg.runId}`,
          runId: msg.runId,
        });
      } catch (err) {
        send(sock, {
          type: "err",
          reqId: msg.reqId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }
    if (msg.type === "eve_resume") {
      try {
        markEveAbort(msg.runId, false);
        eveOwners.set(msg.runId, sock);
        startHostEveExecution(msg.runId, sock, true);
        send(sock, {
          type: "eve_ok",
          reqId: msg.reqId,
          message: `EVE resume on host: ${msg.runId}`,
          runId: msg.runId,
        });
      } catch (err) {
        send(sock, {
          type: "err",
          reqId: msg.reqId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }
    if (msg.type === "eve_pause") {
      try {
        markEveAbort(msg.runId, true);
        const run = await eveService.pause(msg.runId);
        send(sock, {
          type: "eve_ok",
          reqId: msg.reqId,
          message: `paused ${msg.runId}`,
          runId: msg.runId,
          run,
        });
      } catch (err) {
        send(sock, {
          type: "err",
          reqId: msg.reqId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }
    if (msg.type === "eve_kill") {
      try {
        markEveAbort(msg.runId, true);
        const run = await eveService.kill(msg.runId);
        send(sock, {
          type: "eve_ok",
          reqId: msg.reqId,
          message: `killed ${msg.runId}`,
          runId: msg.runId,
          run,
        });
      } catch (err) {
        send(sock, {
          type: "err",
          reqId: msg.reqId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }
    if (msg.type === "eve_status") {
      try {
        const run = await eveService.status(msg.runId);
        if (!run) {
          send(sock, {
            type: "err",
            reqId: msg.reqId,
            error: `unknown EVE run ${msg.runId}`,
          });
          return true;
        }
        send(sock, {
          type: "eve_ok",
          reqId: msg.reqId,
          message: run.status,
          runId: run.runId,
          run,
          text: eveService.formatStatus(run),
        });
      } catch (err) {
        send(sock, {
          type: "err",
          reqId: msg.reqId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }
    if (msg.type === "eve_list") {
      try {
        const runs = await eveService.listRuns(msg.sessionKey);
        const scripts = await eveService.listScripts(msg.repoRoot);
        send(sock, {
          type: "eve_ok",
          reqId: msg.reqId,
          message: `${runs.length} run(s), ${scripts.length} script(s)`,
          runs,
          scripts,
        });
      } catch (err) {
        send(sock, {
          type: "err",
          reqId: msg.reqId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }
    if (msg.type === "eve_answer") {
      try {
        const out = await eveService.answer(msg.runId, msg.answer);
        if (!out.ok) {
          send(sock, {
            type: "err",
            reqId: msg.reqId,
            error: out.error,
          });
          return true;
        }
        send(sock, {
          type: "eve_ok",
          reqId: msg.reqId,
          message: `answered ${msg.runId}: ${out.answer.label}`,
          runId: msg.runId,
          run: out.run,
        });
        // Host restart (or notify-only wait) — no in-process waiter.
        // Resume so the script / auto-ask can pick up the cached answer.
        if (!out.waiterAlive) {
          const st = await eveService.status(msg.runId);
          if (st && (st.status === "waiting_user" || st.status === "paused")) {
            eveOwners.set(msg.runId, sock);
            startHostEveExecution(msg.runId, sock, true);
          }
        }
      } catch (err) {
        send(sock, {
          type: "err",
          reqId: msg.reqId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }
    if (msg.type === "eve_write") {
      try {
        const out = await eveService.writeScript({
          repoRoot: msg.repoRoot,
          name: msg.name,
          source: msg.source,
          scope: msg.scope,
        });
        send(sock, {
          type: "eve_ok",
          reqId: msg.reqId,
          message: `wrote ${out.path}`,
          path: out.path,
          meta: out.meta,
        });
      } catch (err) {
        send(sock, {
          type: "err",
          reqId: msg.reqId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }
    return false;
  }

  async function handleMsg(sock: HostConn, msg: WorkerToHost, opts?: { requireAuth?: boolean; authed?: () => boolean }): Promise<void> {
    if (msg.type === "hello") {
      // handled by connection layer for remote; unix may ignore
      if (opts?.requireAuth) {
        send(sock, { type: "hello_err", reqId: msg.reqId, error: "use connection handshake" });
      } else {
        send(sock, { type: "hello_ok", reqId: msg.reqId });
      }
      return;
    }
    if (opts?.requireAuth && opts.authed && !opts.authed()) {
      send(sock, {
        type: "err",
        reqId: (msg as { reqId?: string }).reqId ?? "?",
        error: "not authenticated — send hello with token first",
      });
      return;
    }
    switch (msg.type) {
      case "ping":
        send(sock, { type: "pong", reqId: msg.reqId });
        return;
      case "list":
        send(sock, {
          type: "list_ok",
          reqId: msg.reqId,
          slots: [...slots.values()].map((s) => ({
            slotKey: s.slotKey,
            agentSessionId: s.agentSessionId,
            agent: s.agent,
            cwd: s.cwd,
            busy: s.busy,
          })),
        });
        return;
      case "ensure":
        await ensureSlot(sock, msg);
        return;
      case "prompt":
        await handlePrompt(sock, msg);
        return;
      case "eve_run":
      case "eve_approve":
      case "eve_resume":
      case "eve_pause":
      case "eve_kill":
      case "eve_status":
      case "eve_list":
      case "eve_write":
      case "eve_answer":
        await handleEveMsg(sock, msg);
        return;
      case "cancel": {
        const slot = slots.get(msg.slotKey);
        if (slot) {
          // Fail any prompts waiting behind the cancelled turn.
          const pending = slot.promptQueue.splice(0);
          for (const q of pending) {
            if (!q.sock.destroyed) {
              send(q.sock, {
                type: "prompt_err",
                reqId: q.msg.reqId,
                slotKey: msg.slotKey,
                error: "cancelled (queued prompt dropped)",
              });
            }
          }
          slot.turnAbort?.abort();
          await slot.host.cancel(msg.slotKey);
        }
        send(sock, {
          type: "cancel_ok",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
        });
        return;
      }
      case "set_mode": {
        const slot = slots.get(msg.slotKey);
        if (!slot) {
          send(sock, {
            type: "err",
            reqId: msg.reqId,
            error: `no slot ${msg.slotKey}`,
          });
          return;
        }
        slot.owner = sock;
        const st = await slot.host.setMode(msg.slotKey, msg.modeId);
        send(sock, {
          type: "set_mode_ok",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
          ...(st.currentModeId ? { currentModeId: st.currentModeId } : {}),
          availableModeIds: st.availableModeIds,
        });
        return;
      }
      case "get_mode": {
        const slot = slots.get(msg.slotKey);
        if (!slot) {
          send(sock, {
            type: "get_mode_ok",
            reqId: msg.reqId,
            slotKey: msg.slotKey,
            availableModeIds: [],
          });
          return;
        }
        const st = await slot.host.getModeState(msg.slotKey);
        send(sock, {
          type: "get_mode_ok",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
          ...(st?.currentModeId ? { currentModeId: st.currentModeId } : {}),
          availableModeIds: st?.availableModeIds ?? [],
        });
        return;
      }
      case "get_config": {
        const slot = slots.get(msg.slotKey);
        if (!slot) {
          send(sock, {
            type: "get_config_ok",
            reqId: msg.reqId,
            slotKey: msg.slotKey,
            configOptions: [],
          });
          return;
        }
        send(sock, {
          type: "get_config_ok",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
          configOptions: await slot.host.getConfigOptions(msg.slotKey),
        });
        return;
      }
      case "set_config": {
        const slot = slots.get(msg.slotKey);
        if (!slot) {
          send(sock, {
            type: "err",
            reqId: msg.reqId,
            error: `no slot ${msg.slotKey}`,
          });
          return;
        }
        slot.owner = sock;
        try {
          const opts = await slot.host.setConfigOption(
            msg.slotKey,
            msg.configId,
            msg.value,
          );
          send(sock, {
            type: "set_config_ok",
            reqId: msg.reqId,
            slotKey: msg.slotKey,
            configOptions: opts,
          });
        } catch (err) {
          send(sock, {
            type: "err",
            reqId: msg.reqId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "kill": {
        const slot = slots.get(msg.slotKey);
        if (slot) {
          try {
            await slot.host.dispose();
          } catch {
            /* */
          }
          slots.delete(msg.slotKey);
          log.info("kill slot", { slotKey: msg.slotKey });
        }
        send(sock, {
          type: "kill_ok",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
        });
        return;
      }
      case "detach": {
        const slot = slots.get(msg.slotKey);
        if (slot && slot.owner === sock) {
          slot.owner = null;
          log.info("detach slot (process kept)", { slotKey: msg.slotKey });
        }
        send(sock, {
          type: "detach_ok",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
        });
        return;
      }
      case "computer_grant": {
        const g = msg.grant;
        if (
          !g ||
          typeof g.enabled !== "boolean" ||
          typeof g.watch !== "boolean" ||
          typeof g.expiresAt !== "number" ||
          typeof g.hostId !== "string"
        ) {
          send(sock, {
            type: "computer_grant_err",
            reqId: msg.reqId,
            slotKey: msg.slotKey,
            error: "invalid grant",
          });
          return;
        }
        computer.applyGrant(msg.slotKey, sock, g);
        const probe = await computer.probe();
        send(sock, {
          type: "computer_grant_ok",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
          probe,
        });
        return;
      }
      case "computer_abort": {
        computer.abort(msg.slotKey);
        send(sock, {
          type: "computer_abort_ok",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
        });
        return;
      }
      case "computer_frame_ack":
        computer.ackFrame(msg.slotKey, msg.frameId);
        return;
      case "permission_result": {
        const slot = slots.get(msg.slotKey);
        const resolve = slot?.permissionResolvers.get(msg.permissionReqId);
        if (resolve) {
          slot!.permissionResolvers.delete(msg.permissionReqId);
          resolve(msg.decision ?? undefined);
        }
        return;
      }
      case "elicitation_result": {
        const slot = slots.get(msg.slotKey);
        const resolve = slot?.elicitationResolvers.get(msg.elicitationReqId);
        if (resolve) {
          slot!.elicitationResolvers.delete(msg.elicitationReqId);
          resolve(msg.decision ?? undefined);
        }
        return;
      }
      case "ask_user_question_result": {
        const slot = slots.get(msg.slotKey);
        const resolve = slot?.askResolvers.get(msg.askReqId);
        if (resolve) {
          slot!.askResolvers.delete(msg.askReqId);
          resolve(msg.result);
        }
        return;
      }
      default:
        send(sock, {
          type: "err",
          reqId: (msg as { reqId?: string }).reqId ?? "?",
          error: "unknown type",
        });
    }
  }

  function wireConn(conn: HostConn, label: string, auth: { required: boolean; token?: string }): { processLine: (line: string) => void; getAuthed: () => boolean } {
    let authed = !auth.required;
    const processLine = (line: string) => {
      if (!line) return;
      let msg: WorkerToHost;
      try {
        msg = JSON.parse(line) as WorkerToHost;
      } catch {
        return;
      }
      if (msg.type === "hello") {
        if (!auth.required) {
          send(conn, { type: "hello_ok", reqId: msg.reqId });
          return;
        }
        const ok =
          Boolean(auth.token) &&
          typeof msg.token === "string" &&
          msg.token === auth.token;
        if (ok) {
          authed = true;
          send(conn, { type: "hello_ok", reqId: msg.reqId });
          log.info("remote worker authenticated", { label });
        } else {
          send(conn, {
            type: "hello_err",
            reqId: msg.reqId,
            error: "invalid host token",
          });
          log.warn("remote worker auth failed", { label });
        }
        return;
      }
      void handleMsg(conn, msg, {
        requireAuth: auth.required,
        authed: () => authed,
      }).catch((e) => {
        log.error("handle error", {
          error: e instanceof Error ? e.message : String(e),
        });
        send(conn, {
          type: "err",
          reqId: (msg as { reqId?: string }).reqId ?? "?",
          error: e instanceof Error ? e.message : String(e),
        });
      });
    };

    return { processLine, getAuthed: () => authed };
  }

  function onConnection(sock: Socket): void {
    let buf = "";
    sock.setEncoding("utf8");
    const conn = asHostConn(sock);
    log.info("worker connected", { slots: slots.size, transport: "unix" });
    const { processLine } = wireConn(conn, "unix", { required: false });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        processLine(line);
      }
    });
    sock.on("close", () => {
      log.info("worker disconnected — slots kept alive", {
        slots: slots.size,
      });
      for (const slot of slots.values()) {
        if (slot.owner === conn) slot.owner = null;
      }
      computer.onOwnerDisconnect(conn);
    });
    sock.on("error", (e) => {
      log.warn("worker socket error", { error: e.message });
    });
  }

  mkdirSync(dirname(sockPath), { recursive: true });
  if (existsSync(sockPath)) {
    try {
      unlinkSync(sockPath);
    } catch {
      /* */
    }
  }

  const server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.listen(sockPath, () => resolve());
    server.on("error", reject);
  });
  log.info("listening", { sockPath });

  const enableScheduler = options.enableScheduler !== false;
  // Always start the loop when enabled so hot-reloaded repos are scanned
  // without restart (empty catalog → no-op ticks).
  if (enableScheduler) {
    const tickMs = options.scheduleTickMs ?? scheduleTickMs(process.env);
    scheduler = startSchedulerLoop({
      repos,
      fire: async ({ sessionKey, repoRoot, text }) =>
        fireScheduledPrompt({ sessionKey, repoRoot, text }),
      log,
      tickMs,
      fireImmediately: true,
    });
    const repoCount = Object.keys(repos).length;
    log.info("scheduler started", {
      repos: repoCount,
      tickMs,
      repoKeys: Object.keys(repos),
    });
  }


  let remoteServer: { stop(): void; port: number } | undefined;
  const remote = options.remoteListen;
  if (remote?.token?.trim() && remote.port != null && remote.port >= 0) {
    const token = remote.token.trim();
    type WsData = { buf: string; conn: HostConn; processLine: (line: string) => void };
    const bunServer = Bun.serve<WsData>({
      hostname: remote.host?.trim() || "127.0.0.1",
      port: remote.port,
      ...(remote.tls
        ? { tls: { cert: remote.tls.cert, key: remote.tls.key } }
        : {}),
      fetch(req, server) {
        const ok = server.upgrade(req, {
          data: {
            buf: "",
            conn: null as unknown as HostConn,
            processLine: () => {},
          },
        });
        if (ok) return undefined;
        return new Response("acpbot host: WebSocket upgrade required\n", {
          status: 426,
        });
      },
      websocket: {
        open(ws) {
          const conn: HostConn = {
            get destroyed() {
              return false;
            },
            write(data: string) {
              try {
                ws.send(data.endsWith("\n") ? data.slice(0, -1) : data.replace(/\n$/, ""));
                // send NDJSON as text frames without requiring trailing newline on wire
                // but protocol uses newline-delimited; send full line without extra
              } catch {
                /* */
              }
            },
          };
          // Prefer sending raw line including newline stripped for WS text
          conn.write = (data: string) => {
            try {
              ws.send(data.endsWith("\n") ? data.slice(0, -1) : data);
            } catch {
              /* */
            }
          };
          const { processLine } = wireConn(conn, "wss", {
            required: true,
            token,
          });
          ws.data.conn = conn;
          ws.data.processLine = processLine;
          ws.data.buf = "";
          log.info("remote worker websocket open", {
            port: remote.port,
            slots: slots.size,
          });
        },
        message(ws, message) {
          const text =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message as ArrayBuffer);
          ws.data.buf += text;
          // Accept either newline-delimited or one JSON object per message
          if (!ws.data.buf.includes("\n")) {
            const line = ws.data.buf.trim();
            if (line.startsWith("{")) {
              ws.data.buf = "";
              ws.data.processLine(line);
            }
            return;
          }
          let i: number;
          while ((i = ws.data.buf.indexOf("\n")) >= 0) {
            const line = ws.data.buf.slice(0, i).trim();
            ws.data.buf = ws.data.buf.slice(i + 1);
            ws.data.processLine(line);
          }
        },
        close(ws) {
          const conn = ws.data.conn;
          log.info("remote worker websocket closed", { slots: slots.size });
          for (const slot of slots.values()) {
            if (slot.owner === conn) slot.owner = null;
          }
          if (conn) computer.onOwnerDisconnect(conn);
        },
      },
    });
    remoteServer = {
      port: bunServer.port,
      stop() {
        bunServer.stop(true);
      },
    };
    log.info("remote WebSocket listening", {
      host: remote.host ?? "127.0.0.1",
      port: bunServer.port,
      tls: Boolean(remote.tls),
    });
  }

  await hostApi.listen();

  const onComputerConfigReloaded = () => {
    if (baseConfig.computer?.enabled !== true) {
      computer.abortAll();
      log.info("computer disabled via reload — grants aborted");
    }
  };

  const close = async () => {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }
    if (remoteServer) {
      try {
        remoteServer.stop();
      } catch {
        /* */
      }
      remoteServer = undefined;
    }
    computer.abortAll();
    try {
      await hostApi.close();
    } catch {
      /* */
    }
    log.info("shutting down — disposing all agent slots");
    for (const [key, slot] of slots) {
      try {
        await slot.host.dispose();
      } catch {
        /* */
      }
      slots.delete(key);
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      server.close(() => {
        clearTimeout(t);
        resolve();
      });
    });
    try {
      unlinkSync(sockPath);
    } catch {
      /* */
    }
  };

  return {
    sockPath,
    close,
    dropSlotsForRepo,
    /** Shared mutable repo catalog (hot-reload mutates in place). */
    repos,
    remotePort: remoteServer?.port,
    hostApiSockPath: hostApiPath,
    config: baseConfig,
    fireScheduledPrompt,
    computerAct: (sessionKey, action) => computer.act(sessionKey, action),
    onComputerConfigReloaded,
    attachTestSlot: (input) => {
      const existing = slots.get(input.slotKey);
      if (existing) {
        if (input.computerAllowed !== undefined) {
          existing.computerAllowed = input.computerAllowed;
        }
        if (input.hostApiToken) existing.hostApiToken = input.hostApiToken;
        if (input.owner !== undefined) existing.owner = input.owner;
        return;
      }
      const dummy: SessionHost =
        options.testSessionHost ??
        ({
          ensureSession: async () => ({
            sessionKey: input.slotKey,
            agentSessionId: "test",
            cwd: "/",
            agent: "test",
          }),
          startTurn: () => ({
            events: (async function* () {
              yield { type: "done" as const, stopReason: "end_turn" };
            })(),
            result: Promise.resolve({ status: "ok" }),
            cancel: async () => {},
          }),
          cancel: async () => {},
          setMode: async () => ({ currentModeId: undefined, availableModeIds: [] }),
          getModeState: async () => ({
            currentModeId: undefined,
            availableModeIds: [],
          }),
          getAvailableModes: async () => [],
          getConfigOptions: async () => [],
          setConfigOption: async () => [],
          disposeSession: async () => {},
          setHooks: () => {},
          dispose: async () => {},
        } satisfies SessionHost);
      slots.set(input.slotKey, {
        slotKey: input.slotKey,
        agent: "test",
        cwd: "/",
        host: dummy,
        agentSessionId: "test",
        owner: input.owner ?? null,
        busy: false,
        promptQueue: [],
        permissionResolvers: new Map(),
        elicitationResolvers: new Map(),
        askResolvers: new Map(),
        computerAllowed: input.computerAllowed === true,
        hostApiToken: input.hostApiToken ?? mintHostApiToken(),
      });
    },
    setTurnSource: (slotKey, source) => {
      const s = slots.get(slotKey);
      if (s) s.turnSource = source;
    },
    ...(scheduler
      ? { scheduleTickNow: () => scheduler!.tickNow() }
      : {}),
  };
}
