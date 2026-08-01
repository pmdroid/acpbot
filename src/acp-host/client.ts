/**
 * Worker-side client for the long-lived acp-host Unix socket.
 * Implements SessionHost so real-agents can swap local vs remote.
 */
import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import type {
  SessionHost,
  SessionHostHooks,
  HostSession,
  HostTurn,
  HostTurnEvent,
  HostModeState,
} from "../acp/session-host";
import {
  type HostToWorker,
  type WorkerToHost,
  type HostAgentConfig,
  defaultAcpHostSock,
} from "./protocol";

export type AcpHostClientOptions = {
  sockPath?: string;
  log?: Logger;
  hooks?: SessionHostHooks;
};

type Pending = {
  resolve: (msg: HostToWorker) => void;
  reject: (err: Error) => void;
};

/** Thrown when acp-host is missing or not responding (worker cannot start). */
export class AcpHostRequiredError extends Error {
  constructor(
    readonly sockPath: string,
    message?: string,
  ) {
    super(
      message ??
        [
          `acp-host is required but is not available.`,
          `  socket: ${sockPath}`,
          `Start it first:`,
          `  bun run acp-host`,
          `(same absolute TACP_STATE_DIR as the worker)`,
        ].join("\n"),
    );
    this.name = "AcpHostRequiredError";
  }
}

/** Resolve host socket path from state dir / env overrides. */
export function resolveAcpHostSockPath(
  stateDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.TACP_ACP_HOST_SOCK?.trim();
  if (fromEnv) return fromEnv;
  return defaultAcpHostSock(stateDir ?? env.TACP_STATE_DIR?.trim());
}

/**
 * Fail-fast readiness for worker boot. acp-host is mandatory:
 * socket must exist and answer `ping` with `pong`.
 */
export async function assertAcpHostReady(options?: {
  stateDir?: string;
  sockPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ sockPath: string }> {
  const env = options?.env ?? process.env;
  const sockPath =
    options?.sockPath?.trim() ||
    resolveAcpHostSockPath(options?.stateDir, env);

  if (!existsSync(sockPath)) {
    throw new AcpHostRequiredError(
      sockPath,
      [
        `acp-host is required but the socket file is missing.`,
        `  socket: ${sockPath}`,
        `Start it first (separate terminal):`,
        `  bun run acp-host`,
        `Use the same absolute TACP_STATE_DIR on both processes.`,
      ].join("\n"),
    );
  }

  const timeoutMs = options?.timeoutMs ?? 3_000;
  const reqId = randomUUID();

  try {
    await new Promise<void>((resolve, reject) => {
      const s = createConnection(sockPath);
      let buf = "";
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`timeout after ${timeoutMs}ms waiting for pong`));
      }, timeoutMs);

      const finish = (err?: Error) => {
        clearTimeout(timer);
        s.destroy();
        if (err) reject(err);
        else resolve();
      };

      s.setEncoding("utf8");
      s.on("connect", () => {
        s.write(JSON.stringify({ type: "ping", reqId }) + "\n");
      });
      s.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as { type?: string; reqId?: string };
            if (msg.type === "pong" && msg.reqId === reqId) {
              finish();
              return;
            }
            if (msg.type === "err" && msg.reqId === reqId) {
              finish(new Error(`host err on ping`));
              return;
            }
          } catch {
            /* ignore partial / non-json */
          }
        }
      });
      s.on("error", (e) => {
        finish(
          new Error(
            e instanceof Error ? e.message : `connect failed: ${String(e)}`,
          ),
        );
      });
      s.on("close", () => {
        /* resolved/rejected via finish */
      });
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AcpHostRequiredError(
      sockPath,
      [
        `acp-host is required but did not respond to ping.`,
        `  socket: ${sockPath}`,
        `  detail: ${detail}`,
        `Is acp-host running? Start: bun run acp-host`,
      ].join("\n"),
    );
  }

  return { sockPath };
}

export function createAcpHostClient(
  options: AcpHostClientOptions = {},
): SessionHost {
  const log = (options.log ?? silentLogger()).child("acp-host-client");
  const sockPath = options.sockPath ?? resolveAcpHostSockPath();
  let hooks: SessionHostHooks = { ...options.hooks };
  let sock: Socket | null = null;
  let buf = "";
  const pending = new Map<string, Pending>();
  /** Active prompt streams: reqId → push event */
  const turnPushes = new Map<
    string,
    {
      push: (ev: HostTurnEvent) => void;
      end: (err?: Error) => void;
      result: (r: {
        status: string;
        stopReason?: string;
        error?: { message?: string };
      }) => void;
    }
  >();
  const modeCache = new Map<string, HostModeState>();
  const configCache = new Map<string, HostSession["configOptions"]>();
  const sessionMeta = new Map<
    string,
    { agent: string; cwd: string; agentSessionId: string }
  >();

  function send(msg: WorkerToHost): void {
    if (!sock || sock.destroyed) {
      throw new Error(`acp-host not connected (${sockPath})`);
    }
    sock.write(`${JSON.stringify(msg)}\n`);
  }

  function request(msg: WorkerToHost, timeoutMs = 600_000): Promise<HostToWorker> {
    const reqId = msg.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`acp-host timeout waiting for ${msg.type}`));
      }, timeoutMs);
      pending.set(reqId, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        send(msg);
      } catch (e) {
        clearTimeout(timer);
        pending.delete(reqId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  function onMessage(msg: HostToWorker): void {
    // Streamed turn events
    if (msg.type === "turn_event") {
      turnPushes.get(msg.reqId)?.push(msg.event);
      return;
    }
    if (msg.type === "prompt_ok") {
      const t = turnPushes.get(msg.reqId);
      if (t) {
        t.result({
          status: msg.status,
          ...(msg.stopReason ? { stopReason: msg.stopReason } : {}),
        });
        t.end();
        turnPushes.delete(msg.reqId);
      }
      const p = pending.get(msg.reqId);
      if (p) {
        pending.delete(msg.reqId);
        p.resolve(msg);
      }
      return;
    }
    if (msg.type === "prompt_err") {
      const t = turnPushes.get(msg.reqId);
      if (t) {
        t.result({
          status: "failed",
          error: { message: msg.error },
        });
        t.end(new Error(msg.error));
        turnPushes.delete(msg.reqId);
      }
      const p = pending.get(msg.reqId);
      if (p) {
        pending.delete(msg.reqId);
        p.reject(new Error(msg.error));
      }
      return;
    }

    // Permission / elicitation / ask — run worker hooks
    if (msg.type === "permission") {
      void (async () => {
        let decision: import("../env/types").PermissionDecision | null = {
          outcome: "reject_once",
        };
        try {
          if (hooks.onPermissionRequest) {
            const d = await hooks.onPermissionRequest(
              {
                sessionId: msg.sessionId,
                toolCallId: msg.toolCallId,
                raw: msg.raw,
              },
              { signal: new AbortController().signal },
            );
            decision = d ?? null;
          }
        } catch {
          decision = { outcome: "cancel" };
        }
        send({
          type: "permission_result",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
          permissionReqId: msg.permissionReqId,
          decision,
        });
      })();
      return;
    }
    if (msg.type === "elicitation") {
      void (async () => {
        let decision: import("../env/types").ElicitationDecision | null = {
          action: "decline",
        };
        try {
          if (hooks.onElicitationRequest) {
            const d = await hooks.onElicitationRequest(
              { sessionId: msg.sessionId, raw: msg.raw },
              { signal: new AbortController().signal },
            );
            decision = d ?? null;
          }
        } catch {
          decision = { action: "cancel" };
        }
        send({
          type: "elicitation_result",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
          elicitationReqId: msg.elicitationReqId,
          decision,
        });
      })();
      return;
    }
    if (msg.type === "ask_user_question") {
      void (async () => {
        let result: Record<string, unknown> = { outcome: "skip_interview" };
        try {
          if (hooks.onAskUserQuestion) {
            result = await hooks.onAskUserQuestion(
              { sessionId: msg.sessionId, raw: msg.raw },
              { signal: new AbortController().signal },
            );
          }
        } catch {
          result = { outcome: "skip_interview" };
        }
        send({
          type: "ask_user_question_result",
          reqId: msg.reqId,
          slotKey: msg.slotKey,
          askReqId: msg.askReqId,
          result,
        });
      })();
      return;
    }

    const p = pending.get(msg.reqId);
    if (p) {
      pending.delete(msg.reqId);
      if (msg.type === "err") p.reject(new Error(msg.error));
      else p.resolve(msg);
    }
  }

  async function connect(): Promise<void> {
    if (sock && !sock.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      const s = createConnection(sockPath);
      s.setEncoding("utf8");
      s.on("connect", () => {
        sock = s;
        log.info("connected to acp-host", { sockPath });
        resolve();
      });
      s.on("error", (e) => {
        reject(
          new Error(
            `acp-host connect failed (${sockPath}): ${e.message}. Start: bun run acp-host`,
          ),
        );
      });
      s.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            onMessage(JSON.parse(line) as HostToWorker);
          } catch {
            /* */
          }
        }
      });
      s.on("close", () => {
        log.warn("acp-host connection closed");
        sock = null;
        for (const [, p] of pending) {
          p.reject(new Error("acp-host disconnected"));
        }
        pending.clear();
      });
    });
  }

  const api: SessionHost = {
    setHooks(next) {
      hooks = { ...hooks, ...next };
    },

    async ensureSession(input) {
      await connect();
      const reqId = randomUUID();
      const config: HostAgentConfig = {
        agent: input.agent,
        cwd: input.cwd,
      };
      const msg = await request({
        type: "ensure",
        reqId,
        slotKey: input.sessionKey,
        config,
      });
      if (msg.type !== "ensure_ok") {
        throw new Error(
          msg.type === "err" ? msg.error : `unexpected ${msg.type}`,
        );
      }
      sessionMeta.set(input.sessionKey, {
        agent: input.agent,
        cwd: input.cwd,
        agentSessionId: msg.agentSessionId,
      });
      modeCache.set(input.sessionKey, {
        currentModeId: msg.currentModeId,
        availableModeIds: msg.availableModeIds,
      });
      // Refresh config options (model select, etc.)
      try {
        const cfg = await request({
          type: "get_config",
          reqId: randomUUID(),
          slotKey: input.sessionKey,
        });
        if (cfg.type === "get_config_ok") {
          configCache.set(
            input.sessionKey,
            cfg.configOptions as HostSession["configOptions"],
          );
        }
      } catch {
        configCache.set(input.sessionKey, []);
      }
      return {
        sessionKey: input.sessionKey,
        agentSessionId: msg.agentSessionId,
        cwd: input.cwd,
        agent: input.agent,
        currentModeId: msg.currentModeId,
        availableModeIds: msg.availableModeIds,
        configOptions: configCache.get(input.sessionKey) ?? [],
      } satisfies HostSession;
    },

    startTurn(input) {
      const reqId = randomUUID();
      const queue: HostTurnEvent[] = [];
      let wait: ((v: IteratorResult<HostTurnEvent>) => void) | null = null;
      let done = false;
      let fail: Error | undefined;

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

      turnPushes.set(reqId, {
        push: (ev) => {
          if (wait) {
            const w = wait;
            wait = null;
            w({ value: ev, done: false });
          } else queue.push(ev);
        },
        end: (err) => {
          done = true;
          fail = err;
          if (wait) {
            const w = wait;
            wait = null;
            if (err) w({ value: undefined as never, done: true });
            else w({ value: undefined as never, done: true });
          }
        },
        result: resolveResult,
      });

      void connect()
        .then(() => {
          send({
            type: "prompt",
            reqId,
            slotKey: input.sessionKey,
            text: input.text,
            ...(input.attachments ? { attachments: input.attachments } : {}),
          });
        })
        .catch((e) => {
          turnPushes.get(reqId)?.result({
            status: "failed",
            error: {
              message: e instanceof Error ? e.message : String(e),
            },
          });
          turnPushes.get(reqId)?.end(
            e instanceof Error ? e : new Error(String(e)),
          );
          turnPushes.delete(reqId);
        });

      // Also wait for prompt_ok via pending so request() isn't needed
      pending.set(reqId, {
        resolve: () => {},
        reject: (e) => {
          turnPushes.get(reqId)?.result({
            status: "failed",
            error: { message: e.message },
          });
          turnPushes.get(reqId)?.end(e);
          turnPushes.delete(reqId);
        },
      });

      const events = (async function* (): AsyncGenerator<HostTurnEvent> {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          if (done) {
            if (fail) {
              yield { type: "error", message: fail.message };
            }
            return;
          }
          await new Promise<void>((resolve) => {
            wait = (r) => {
              if (!r.done && r.value) queue.push(r.value);
              resolve();
            };
          });
        }
      })();

      return {
        events,
        result,
        cancel: async () => {
          try {
            await connect();
            const cid = randomUUID();
            await request({
              type: "cancel",
              reqId: cid,
              slotKey: input.sessionKey,
            });
          } catch {
            /* */
          }
        },
      } satisfies HostTurn;
    },

    async cancel(sessionKey) {
      await connect();
      await request({
        type: "cancel",
        reqId: randomUUID(),
        slotKey: sessionKey,
      });
    },

    async setMode(sessionKey, modeId) {
      await connect();
      const msg = await request({
        type: "set_mode",
        reqId: randomUUID(),
        slotKey: sessionKey,
        modeId,
      });
      if (msg.type !== "set_mode_ok") {
        throw new Error(
          msg.type === "err" ? msg.error : `unexpected ${msg.type}`,
        );
      }
      const st = {
        currentModeId: msg.currentModeId,
        availableModeIds: msg.availableModeIds,
      };
      modeCache.set(sessionKey, st);
      return st;
    },

    async getModeState(sessionKey) {
      await connect();
      const msg = await request({
        type: "get_mode",
        reqId: randomUUID(),
        slotKey: sessionKey,
      });
      if (msg.type !== "get_mode_ok") {
        return modeCache.get(sessionKey);
      }
      const st: HostModeState = {
        currentModeId: msg.currentModeId,
        availableModeIds: msg.availableModeIds,
      };
      modeCache.set(sessionKey, st);
      return st;
    },

    async getAvailableModes(sessionKey) {
      const st = await api.getModeState(sessionKey);
      return st?.availableModeIds ?? [];
    },

    async getConfigOptions(sessionKey) {
      await connect();
      const msg = await request({
        type: "get_config",
        reqId: randomUUID(),
        slotKey: sessionKey,
      });
      if (msg.type !== "get_config_ok") {
        return (configCache.get(sessionKey) ?? []) as Awaited<
          ReturnType<SessionHost["getConfigOptions"]>
        >;
      }
      const opts = (msg.configOptions ?? []) as Awaited<
        ReturnType<SessionHost["getConfigOptions"]>
      >;
      configCache.set(sessionKey, opts);
      return opts;
    },

    async setConfigOption(sessionKey, configId, value) {
      await connect();
      const msg = await request({
        type: "set_config",
        reqId: randomUUID(),
        slotKey: sessionKey,
        configId,
        value,
      });
      if (msg.type !== "set_config_ok") {
        throw new Error(
          msg.type === "err" ? msg.error : `unexpected ${msg.type}`,
        );
      }
      const opts = (msg.configOptions ?? []) as Awaited<
        ReturnType<SessionHost["getConfigOptions"]>
      >;
      configCache.set(sessionKey, opts);
      return opts;
    },

    async disposeSession(sessionKey) {
      await connect();
      await request({
        type: "kill",
        reqId: randomUUID(),
        slotKey: sessionKey,
      });
      sessionMeta.delete(sessionKey);
      modeCache.delete(sessionKey);
      configCache.delete(sessionKey);
    },

    async dispose() {
      // Detach only — do not kill host slots
      if (sock && !sock.destroyed) {
        for (const slotKey of sessionMeta.keys()) {
          try {
            send({
              type: "detach",
              reqId: randomUUID(),
              slotKey,
            });
          } catch {
            /* */
          }
        }
        sock.destroy();
      }
      sock = null;
    },
  };
  return api;
}
