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
import {
  parseReposFromEnv,
  scheduleTickMs,
  startSchedulerLoop,
  type FireJobResult,
  type SchedulerLoopHandle,
} from "./scheduler";

type QueuedHostPrompt = {
  sock: Socket;
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
  owner: Socket | null;
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
};

function send(sock: Socket, msg: HostToWorker): void {
  if (sock.destroyed) return;
  sock.write(`${JSON.stringify(msg)}\n`);
}

export async function startAcpHostServer(
  options: AcpHostServerOptions = {},
): Promise<{
  sockPath: string;
  close: () => Promise<void>;
  /** Exposed for tests — run one schedule tick. */
  scheduleTickNow?: () => Promise<import("./scheduler").TickResult>;
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
  const repos: Record<string, string> =
    options.repos ??
    baseConfig.repos ??
    parseReposFromEnv(process.env);

  const slots = new Map<string, Slot>();
  let scheduler: SchedulerLoopHandle | null = null;

  function makeHooks(slotKey: string): SessionHostHooks {
    return {
      onPermissionRequest: async (req, ctx) => {
        const slot = slots.get(slotKey);
        if (slot?.permissionMode === "bypass") {
          log.info("permission auto-approved (bypass)", {
            slotKey,
            toolCallId: req.toolCallId,
          });
          return { outcome: "allow_always" };
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

  async function ensureSlot(
    sock: Socket,
    msg: Extract<WorkerToHost, { type: "ensure" }>,
  ): Promise<void> {
    const { slotKey, config } = msg;
    let slot = slots.get(slotKey);

    // Reattach: same agent+cwd, prefer resume if agentSessionId matches or any live
    if (slot) {
      const same =
        slot.agent === config.agent &&
        slot.cwd === config.cwd &&
        (slot.permissionMode ?? "ask") === (config.permissionMode ?? "ask");
      if (same) {
        slot.owner = sock;
        try {
          const hs = await slot.host.ensureSession({
            sessionKey: slotKey,
            agent: config.agent,
            cwd: config.cwd,
            ...(config.permissionMode
              ? { permissionMode: config.permissionMode }
              : {}),
          });
          slot.agentSessionId = hs.agentSessionId;
          const mode = await slot.host.getModeState(slotKey);
          send(sock, {
            type: "ensure_ok",
            reqId: msg.reqId,
            slotKey,
            agentSessionId: hs.agentSessionId,
            wasNew: false,
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

    const host = createSessionHost({
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

    try {
      // Resume via durable store is inside createSessionHost using sessionKey
      const hs = await host.ensureSession({
        sessionKey: slotKey,
        agent: config.agent,
        cwd: config.cwd,
        ...(config.permissionMode
          ? { permissionMode: config.permissionMode }
          : {}),
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
    try {
      const turn = slot.host.startTurn({
        sessionKey: msg.slotKey,
        text: msg.text,
        ...(msg.attachments ? { attachments: msg.attachments } : {}),
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
  }): Promise<Slot> {
    const { slotKey, agent, cwd } = args;
    let slot = slots.get(slotKey);

    if (slot) {
      const same = slot.agent === agent && slot.cwd === cwd;
      if (same) {
        try {
          const hs = await slot.host.ensureSession({
            sessionKey: slotKey,
            agent,
            cwd,
          });
          slot.agentSessionId = hs.agentSessionId;
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

    const host = createSessionHost({
      config: {
        ...baseConfig,
      },
      stateDir,
      ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
      log,
      hooks: makeHooks(slotKey),
    });

    try {
      const hs = await host.ensureSession({
        sessionKey: slotKey,
        agent,
        cwd,
      });
      const created: Slot = {
        slotKey,
        agent,
        cwd,
        host,
        agentSessionId: hs.agentSessionId,
        owner: null,
        busy: false,
        promptQueue: [],
        permissionResolvers: new Map(),
        elicitationResolvers: new Map(),
        askResolvers: new Map(),
      };
      slots.set(slotKey, created);
      log.info("schedule ensure new/load", {
        slotKey,
        agent,
        agentSessionId: hs.agentSessionId,
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
    }
  }

  async function handleMsg(sock: Socket, msg: WorkerToHost): Promise<void> {
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

  function onConnection(sock: Socket): void {
    let buf = "";
    sock.setEncoding("utf8");
    log.info("worker connected", { slots: slots.size });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: WorkerToHost;
        try {
          msg = JSON.parse(line) as WorkerToHost;
        } catch {
          continue;
        }
        void handleMsg(sock, msg).catch((e) => {
          log.error("handle error", {
            error: e instanceof Error ? e.message : String(e),
          });
          send(sock, {
            type: "err",
            reqId: (msg as { reqId?: string }).reqId ?? "?",
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }
    });
    sock.on("close", () => {
      log.info("worker disconnected — slots kept alive", {
        slots: slots.size,
      });
      for (const slot of slots.values()) {
        if (slot.owner === sock) slot.owner = null;
      }
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
  const repoCount = Object.keys(repos).length;
  if (enableScheduler && repoCount > 0) {
    const tickMs = options.scheduleTickMs ?? scheduleTickMs(process.env);
    scheduler = startSchedulerLoop({
      repos,
      fire: async ({ sessionKey, repoRoot, text }) =>
        fireScheduledPrompt({ sessionKey, repoRoot, text }),
      log,
      tickMs,
      fireImmediately: true,
    });
    log.info("scheduler started", {
      repos: repoCount,
      tickMs,
      repoKeys: Object.keys(repos),
    });
  } else if (enableScheduler) {
    log.info("scheduler idle (no ACPBOT_REPOS_JSON / repos catalog)");
  }

  const close = async () => {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      unlinkSync(sockPath);
    } catch {
      /* */
    }
  };

  return {
    sockPath,
    close,
    ...(scheduler
      ? { scheduleTickNow: () => scheduler!.tickNow() }
      : {}),
  };
}
