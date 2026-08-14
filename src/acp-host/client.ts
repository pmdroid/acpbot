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
  /**
   * Remote WebSocket URL (ws:// or wss://). When set, Unix sockPath is ignored
   * and hello+token auth is required.
   */
  url?: string;
  /** Shared secret for remote host (required with url). */
  token?: string;
  /** Unsolicited EVE progress from host (Telegram delivery). */
  onEveNotify?: (msg: {
    sessionKey: string;
    text: string;
    runId?: string;
    ask?: Array<{ id: string; label: string }>;
  }) => void;
};

export type EveHostResult = {
  message?: string;
  runId?: string;
  run?: unknown;
  text?: string;
  runs?: unknown[];
  scripts?: unknown[];
  path?: string;
  meta?: unknown;
};

/** SessionHost plus EVE control plane (orchestration runs on acp-host). */
export type AcpHostClientApi = SessionHost & {
  eveRun(input: {
    sessionKey: string;
    repoKey: string;
    repoRoot: string;
    name?: string;
    path?: string;
    source?: string;
    args?: unknown;
    skipApproval?: boolean;
    agentsMax?: number;
  }): Promise<EveHostResult>;
  eveApprove(input: {
    sessionKey: string;
    runId: string;
  }): Promise<EveHostResult>;
  eveStatus(runId: string): Promise<EveHostResult>;
  eveList(input: {
    sessionKey: string;
    repoRoot: string;
  }): Promise<EveHostResult>;
  evePause(runId: string): Promise<EveHostResult>;
  eveResume(input: {
    sessionKey: string;
    runId: string;
  }): Promise<EveHostResult>;
  eveKill(runId: string): Promise<EveHostResult>;
  eveWrite(input: {
    repoRoot: string;
    name: string;
    source: string;
    scope?: "project" | "user";
  }): Promise<EveHostResult>;
  eveAnswer(input: {
    sessionKey: string;
    runId: string;
    answer: string;
  }): Promise<EveHostResult>;
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
          `  acpbot host`,
          `(same absolute ACPBOT_STATE_DIR as the worker)`,
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
  const fromEnv = env.ACPBOT_ACP_HOST_SOCK?.trim();
  if (fromEnv) return fromEnv;
  return defaultAcpHostSock(stateDir ?? env.ACPBOT_STATE_DIR?.trim());
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
        `  acpbot host`,
        `Use the same absolute ACPBOT_STATE_DIR on both processes.`,
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
        `Is acp-host running? Start: acpbot host`,
      ].join("\n"),
    );
  }

  return { sockPath };
}

export function createAcpHostClient(
  options: AcpHostClientOptions = {},
): AcpHostClientApi {
  const log = (options.log ?? silentLogger()).child("acp-host-client");
  const remoteUrl = options.url?.trim();
  const remoteToken = options.token?.trim();
  const sockPath = options.sockPath ?? resolveAcpHostSockPath();
  const endpointLabel = remoteUrl || sockPath;
  let hooks: SessionHostHooks = { ...options.hooks };
  const onEveNotify = options.onEveNotify;
  let sock: Socket | null = null;
  let ws: WebSocket | null = null;
  let buf = "";
  let helloDone = !remoteUrl;
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
    const line = `${JSON.stringify(msg)}\n`;
    if (remoteUrl) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error(`acp-host not connected (${endpointLabel})`);
      }
      // One JSON object per WS text frame (also accept newline form).
      ws.send(JSON.stringify(msg));
      return;
    }
    if (!sock || sock.destroyed) {
      throw new Error(`acp-host not connected (${endpointLabel})`);
    }
    sock.write(line);
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
    // Unsolicited EVE progress (no reqId wait)
    if (msg.type === "eve_notify") {
      try {
        onEveNotify?.({
          sessionKey: msg.sessionKey,
          text: msg.text,
          ...(msg.runId ? { runId: msg.runId } : {}),
          ...(msg.ask ? { ask: msg.ask } : {}),
        });
      } catch {
        /* */
      }
      return;
    }
    if (msg.type === "eve_ok") {
      const p = pending.get(msg.reqId);
      if (p) {
        pending.delete(msg.reqId);
        p.resolve(msg);
      }
      return;
    }
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

  function ingestLine(line: string): void {
    if (!line) return;
    try {
      onMessage(JSON.parse(line) as HostToWorker);
    } catch {
      /* */
    }
  }

  async function connectWs(): Promise<void> {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* */
      }
      ws = null;
    }
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(remoteUrl!);
      let settled = false;
      ws = socket;
      socket.addEventListener("open", () => {
        log.info("connected to acp-host (websocket)", { url: remoteUrl });
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      socket.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `acp-host websocket connect failed (${remoteUrl}). Is host remoteListen up?`,
            ),
          );
        }
      });
      socket.addEventListener("message", (ev) => {
        const text = typeof ev.data === "string" ? ev.data : String(ev.data);
        if (text.includes("\n")) {
          buf += text;
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            ingestLine(line);
          }
        } else {
          ingestLine(text.trim());
        }
      });
      socket.addEventListener("close", () => {
        log.warn("acp-host websocket closed");
        ws = null;
        helloDone = false;
        for (const [, pend] of pending) {
          pend.reject(new Error("acp-host disconnected"));
        }
        pending.clear();
      });
    });
  }

  async function connect(): Promise<void> {
    if (remoteUrl) {
      if (ws && ws.readyState === WebSocket.OPEN && helloDone) return;
      await connectWs();
      if (!helloDone) {
        if (!remoteToken) {
          throw new Error(
            `acp-host remote url set but no token (host "${remoteUrl}")`,
          );
        }
        const reqId = randomUUID();
        const reply = await request(
          { type: "hello", reqId, token: remoteToken, client: "worker" },
          10_000,
        );
        if (reply.type === "hello_err") {
          throw new Error(`acp-host auth failed: ${reply.error}`);
        }
        if (reply.type !== "hello_ok") {
          throw new Error(`acp-host auth unexpected: ${reply.type}`);
        }
        helloDone = true;
        log.info("acp-host remote hello ok", { url: remoteUrl });
      }
      return;
    }

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
            `acp-host connect failed (${sockPath}): ${e.message}. Start: acpbot host`,
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
          ingestLine(line);
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
        ...(input.permissionMode
          ? { permissionMode: input.permissionMode }
          : {}),
        ...(input.forceRespawn ? { forceRespawn: true } : {}),
        ...(input.forceNewSession ? { forceNewSession: true } : {}),
      };
      // Load+new recovery is bounded (~45s + 45s + 45s); don't wait 10 minutes.
      const msg = await request(
        {
          type: "ensure",
          reqId,
          slotKey: input.sessionKey,
          config,
        },
        180_000,
      );
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

    // ── EVE (host-side orchestration) ────────────────────────────────────
    async eveRun(input) {
      await connect();
      const msg = await request({
        type: "eve_run",
        reqId: randomUUID(),
        sessionKey: input.sessionKey,
        repoKey: input.repoKey,
        repoRoot: input.repoRoot,
        ...(input.name ? { name: input.name } : {}),
        ...(input.path ? { path: input.path } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.skipApproval != null
          ? { skipApproval: input.skipApproval }
          : {}),
        ...(input.agentsMax != null ? { agentsMax: input.agentsMax } : {}),
      });
      if (msg.type !== "eve_ok") {
        throw new Error(
          msg.type === "err" ? msg.error : `unexpected ${msg.type}`,
        );
      }
      return {
        message: msg.message,
        runId: msg.runId,
        run: msg.run,
      };
    },
    async eveApprove(input) {
      await connect();
      const msg = await request({
        type: "eve_approve",
        reqId: randomUUID(),
        sessionKey: input.sessionKey,
        runId: input.runId,
      });
      if (msg.type !== "eve_ok") {
        throw new Error(
          msg.type === "err" ? msg.error : `unexpected ${msg.type}`,
        );
      }
      return { message: msg.message, runId: msg.runId, run: msg.run };
    },
    async eveStatus(runId) {
      await connect();
      const msg = await request({
        type: "eve_status",
        reqId: randomUUID(),
        runId,
      });
      if (msg.type !== "eve_ok") {
        throw new Error(
          msg.type === "err" ? msg.error : `unexpected ${msg.type}`,
        );
      }
      return {
        message: msg.message,
        runId: msg.runId,
        run: msg.run,
        text: msg.text,
      };
    },
    async eveList(input) {
      await connect();
      const msg = await request({
        type: "eve_list",
        reqId: randomUUID(),
        sessionKey: input.sessionKey,
        repoRoot: input.repoRoot,
      });
      if (msg.type !== "eve_ok") {
        throw new Error(
          msg.type === "err" ? msg.error : `unexpected ${msg.type}`,
        );
      }
      return {
        message: msg.message,
        runs: msg.runs,
        scripts: msg.scripts,
      };
    },
    async evePause(runId) {
      await connect();
      const msg = await request({
        type: "eve_pause",
        reqId: randomUUID(),
        runId,
      });
      if (msg.type !== "eve_ok") {
        throw new Error(
          msg.type === "err" ? msg.error : `unexpected ${msg.type}`,
        );
      }
      return { message: msg.message, runId: msg.runId, run: msg.run };
    },
    async eveResume(input) {
      await connect();
      const msg = await request({
        type: "eve_resume",
        reqId: randomUUID(),
        sessionKey: input.sessionKey,
        runId: input.runId,
      });
      if (msg.type !== "eve_ok") {
        throw new Error(
          msg.type === "err" ? msg.error : `unexpected ${msg.type}`,
        );
      }
      return { message: msg.message, runId: msg.runId, run: msg.run };
    },
    async eveKill(runId) {
      await connect();
      const msg = await request({
        type: "eve_kill",
        reqId: randomUUID(),
        runId,
      });
      if (msg.type !== "eve_ok") {
        throw new Error(
          msg.type === "err" ? msg.error : `unexpected ${msg.type}`,
        );
      }
      return { message: msg.message, runId: msg.runId, run: msg.run };
    },
    async eveWrite(input) {
      await connect();
      const msg = await request({
        type: "eve_write",
        reqId: randomUUID(),
        repoRoot: input.repoRoot,
        name: input.name,
        source: input.source,
        ...(input.scope ? { scope: input.scope } : {}),
      });
      if (msg.type !== "eve_ok") {
        throw new Error(
          msg.type === "err" ? msg.error : `unexpected ${msg.type}`,
        );
      }
      return {
        message: msg.message,
        path: msg.path,
        meta: msg.meta,
      };
    },
    async eveAnswer(input) {
      await connect();
      const msg = await request({
        type: "eve_answer",
        reqId: randomUUID(),
        sessionKey: input.sessionKey,
        runId: input.runId,
        answer: input.answer,
      });
      if (msg.type !== "eve_ok") {
        throw new Error(
          msg.type === "err" ? msg.error : `unexpected ${msg.type}`,
        );
      }
      return { message: msg.message, runId: msg.runId, run: msg.run };
    },
  };
  return api;
}
