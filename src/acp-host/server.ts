/**
 * ACP host server: owns agent stdio processes across worker reconnects.
 */
import { createServer, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import type { TacpConfig } from "../env/types";
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

type Slot = {
  slotKey: string;
  agent: string;
  cwd: string;
  host: SessionHost;
  agentSessionId: string | null;
  owner: Socket | null;
  busy: boolean;
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
  config?: TacpConfig;
  sessionStore?: HostSessionStore;
  log?: Logger;
};

function send(sock: Socket, msg: HostToWorker): void {
  if (sock.destroyed) return;
  sock.write(`${JSON.stringify(msg)}\n`);
}

export async function startAcpHostServer(
  options: AcpHostServerOptions = {},
): Promise<{ sockPath: string; close: () => Promise<void> }> {
  const log = (options.log ?? silentLogger()).child("acp-host");
  const stateDir =
    options.stateDir ??
    process.env.TACP_ACPX_STATE_DIR?.trim() ??
    "./data/acpx-state";
  const sockPath = options.sockPath ?? defaultAcpHostSock(stateDir);
  const baseConfig: TacpConfig = options.config ?? {
    operatorUserId: 0,
    mcpEnabled: true,
  };

  const slots = new Map<string, Slot>();

  function makeHooks(slotKey: string): SessionHostHooks {
    return {
      onPermissionRequest: async (req, ctx) => {
        const slot = slots.get(slotKey);
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
        slot.agent === config.agent && slot.cwd === config.cwd;
      if (same) {
        slot.owner = sock;
        try {
          const hs = await slot.host.ensureSession({
            sessionKey: slotKey,
            agent: config.agent,
            cwd: config.cwd,
          });
          slot.agentSessionId = hs.agentSessionId;
          const mode = slot.host.getModeState(slotKey);
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
      });
      const mode = host.getModeState(slotKey);
      slots.set(slotKey, {
        slotKey,
        agent: config.agent,
        cwd: config.cwd,
        host,
        agentSessionId: hs.agentSessionId,
        owner: sock,
        busy: false,
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
    slot.owner = sock;
    slot.busy = true;
    try {
      const turn = slot.host.startTurn({
        sessionKey: msg.slotKey,
        text: msg.text,
        ...(msg.attachments ? { attachments: msg.attachments } : {}),
      });
      for await (const event of turn.events) {
        send(sock, {
          type: "turn_event",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
          event,
        });
      }
      const result = await turn.result;
      send(sock, {
        type: "prompt_ok",
        reqId: msg.reqId,
        slotKey: msg.slotKey,
        status: result.status,
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      });
    } catch (err) {
      send(sock, {
        type: "prompt_err",
        reqId: msg.reqId,
        slotKey: msg.slotKey,
        error: err instanceof Error ? err.message : String(err),
      });
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
        if (slot) await slot.host.cancel(msg.slotKey);
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
        const st = slot.host.getModeState(msg.slotKey);
        send(sock, {
          type: "get_mode_ok",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
          ...(st?.currentModeId ? { currentModeId: st.currentModeId } : {}),
          availableModeIds: st?.availableModeIds ?? [],
        });
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

  const close = async () => {
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

  return { sockPath, close };
}
