/**
 * Worker outbound API client (HTTP over Unix socket).
 *
 * The MCP server (agent child) cannot hold the Telegram bot token.
 * It POSTs to the acpbot worker/daemon, which owns token + session topics.
 *
 * Socket path: `$ACPBOT_STATE_DIR/worker-api.sock`
 * Env: `ACPBOT_WORKER_API_SOCK` (absolute path, preferred).
 */
import { request as httpRequest } from "node:http";
import { join } from "node:path";

export const WORKER_API_SOCK_NAME = "worker-api.sock";

export function workerApiSockPath(
  stateDir = process.env.ACPBOT_STATE_DIR?.trim() || "./data/acpbot-state",
): string {
  const fromEnv = process.env.ACPBOT_WORKER_API_SOCK?.trim();
  if (fromEnv) return fromEnv;
  return join(stateDir.replace(/\/$/, ""), WORKER_API_SOCK_NAME);
}

export type WorkerApiOk = { ok: true; message?: string; bytes?: number };
export type WorkerApiErr = { ok: false; error: string };
export type WorkerApiResult = WorkerApiOk | WorkerApiErr;

export type WorkerTelegramMessageBody = {
  sessionKey: string;
  text: string;
  kind?: "update" | "message";
};

export type WorkerTelegramPhotoBody = {
  sessionKey: string;
  path: string;
  caption?: string;
  filename?: string;
};

export type WorkerTelegramDocumentBody = {
  sessionKey: string;
  path: string;
  caption?: string;
  filename?: string;
};

export type WorkerTelegramSpeakBody = {
  sessionKey: string;
  text: string;
};

export async function workerApiRequest(
  path: string,
  body: unknown,
  opts?: {
    sockPath?: string;
    timeoutMs?: number;
    method?: string;
  },
): Promise<WorkerApiResult> {
  const sockPath = opts?.sockPath ?? workerApiSockPath();
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const method = opts?.method ?? "POST";
  const payload =
    method === "GET" || body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve) => {
    const req = httpRequest(
      {
        socketPath: sockPath,
        path,
        method,
        headers: {
          accept: "application/json",
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const json = JSON.parse(raw) as WorkerApiResult;
            if (json && typeof json === "object" && "ok" in json) {
              resolve(json);
              return;
            }
            resolve({
              ok: false,
              error: `invalid worker response (${res.statusCode}): ${raw.slice(0, 200)}`,
            });
          } catch {
            resolve({
              ok: false,
              error: `worker HTTP ${res.statusCode}: ${raw.slice(0, 200) || "(empty)"}`,
            });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({
        ok: false,
        error: `worker API timed out after ${timeoutMs}ms (${path})`,
      });
    });
    req.on("error", (err) => {
      resolve({
        ok: false,
        error:
          `worker API unreachable at ${sockPath}: ${err.message}. ` +
          `Is the acpbot daemon running?`,
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export async function workerSendMessage(
  body: WorkerTelegramMessageBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult> {
  return workerApiRequest("/v1/telegram/message", body, opts);
}

export async function workerSendPhoto(
  body: WorkerTelegramPhotoBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult> {
  return workerApiRequest("/v1/telegram/photo", body, {
    ...opts,
    timeoutMs: opts?.timeoutMs ?? 60_000,
  });
}

export async function workerSendDocument(
  body: WorkerTelegramDocumentBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult> {
  return workerApiRequest("/v1/telegram/document", body, {
    ...opts,
    timeoutMs: opts?.timeoutMs ?? 90_000,
  });
}

export async function workerSpeak(
  body: WorkerTelegramSpeakBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult> {
  return workerApiRequest("/v1/telegram/speak", body, {
    ...opts,
    timeoutMs: opts?.timeoutMs ?? 90_000,
  });
}

export async function workerHealth(opts?: {
  sockPath?: string;
}): Promise<WorkerApiResult> {
  return workerApiRequest("/v1/health", undefined, {
    ...opts,
    method: "GET",
    timeoutMs: 5_000,
  });
}

// ── Multi-agent spawn (MCP → worker) ─────────────────────────────────────────

export type WorkerAgentSpawnBody = {
  sessionKey: string;
  name: string;
  agent?: string;
  role?: string;
  prompt?: string;
  /** Default true — no Telegram topic; permissions on parent. */
  headless?: boolean;
};

export type WorkerAgentListBody = { sessionKey: string };
export type WorkerAgentKillBody = {
  sessionKey: string;
  childSessionKey?: string;
  id?: string;
  dispose?: boolean;
  /** Hard kill only: delete git worktree (default false — keep on disk). */
  remove_worktree?: boolean;
};
export type WorkerAgentSendBody = {
  sessionKey: string;
  to: string;
  message: string;
  mode?: "prompt" | "steer";
};
export type WorkerAgentWaitBody = {
  sessionKey: string;
  childSessionKey?: string;
  id?: string;
  to?: string;
  timeout_sec?: number;
  poll_sec?: number;
};

export async function workerAgentSpawn(
  body: WorkerAgentSpawnBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult & { record?: unknown }> {
  return workerApiRequest("/v1/agents/spawn", body, opts) as Promise<
    WorkerApiResult & { record?: unknown }
  >;
}

export async function workerAgentList(
  body: WorkerAgentListBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult & { children?: unknown[] }> {
  return workerApiRequest("/v1/agents/list", body, opts) as Promise<
    WorkerApiResult & { children?: unknown[] }
  >;
}

export async function workerAgentKill(
  body: WorkerAgentKillBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult> {
  return workerApiRequest("/v1/agents/kill", body, opts);
}

export async function workerAgentSend(
  body: WorkerAgentSendBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult & { to?: string; summary?: string }> {
  return workerApiRequest("/v1/agents/send", body, opts) as Promise<
    WorkerApiResult & { to?: string; summary?: string }
  >;
}

// ── EVE directives (MCP → worker) ────────────────────────────────────────────

export type WorkerEveRunBody = {
  sessionKey: string;
  name?: string;
  path?: string;
  source?: string;
  args?: unknown;
  skip_approval?: boolean;
  agents_max?: number;
};
export type WorkerEveRunIdBody = { sessionKey: string; runId: string };
export type WorkerEveWriteBody = {
  sessionKey: string;
  name: string;
  source: string;
  scope?: "project" | "user";
};
export type WorkerEveListBody = { sessionKey: string };

export async function workerEveRun(
  body: WorkerEveRunBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult & { run?: unknown; runId?: string }> {
  return workerApiRequest("/v1/eve/run", body, {
    ...opts,
    timeoutMs: opts?.timeoutMs ?? 120_000,
  }) as Promise<WorkerApiResult & { run?: unknown; runId?: string }>;
}

export async function workerEveApprove(
  body: WorkerEveRunIdBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult & { run?: unknown }> {
  return workerApiRequest("/v1/eve/approve", body, {
    ...opts,
    timeoutMs: opts?.timeoutMs ?? 0, // long-running; worker returns after start queue
  }) as Promise<WorkerApiResult & { run?: unknown }>;
}

export async function workerEveStatus(
  body: WorkerEveRunIdBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult & { run?: unknown; text?: string }> {
  return workerApiRequest("/v1/eve/status", body, opts) as Promise<
    WorkerApiResult & { run?: unknown; text?: string }
  >;
}

export async function workerEveList(
  body: WorkerEveListBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<
  WorkerApiResult & {
    runs?: unknown[];
    scripts?: unknown[];
  }
> {
  return workerApiRequest("/v1/eve/list", body, opts) as Promise<
    WorkerApiResult & { runs?: unknown[]; scripts?: unknown[] }
  >;
}

export async function workerEvePause(
  body: WorkerEveRunIdBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult & { run?: unknown }> {
  return workerApiRequest("/v1/eve/pause", body, opts) as Promise<
    WorkerApiResult & { run?: unknown }
  >;
}

export async function workerEveResume(
  body: WorkerEveRunIdBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult & { run?: unknown }> {
  return workerApiRequest("/v1/eve/resume", body, opts) as Promise<
    WorkerApiResult & { run?: unknown }
  >;
}

export async function workerEveKill(
  body: WorkerEveRunIdBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult & { run?: unknown }> {
  return workerApiRequest("/v1/eve/kill", body, opts) as Promise<
    WorkerApiResult & { run?: unknown }
  >;
}

export async function workerEveWrite(
  body: WorkerEveWriteBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<WorkerApiResult & { path?: string; meta?: unknown }> {
  return workerApiRequest("/v1/eve/write", body, opts) as Promise<
    WorkerApiResult & { path?: string; meta?: unknown }
  >;
}

export async function workerAgentWait(
  body: WorkerAgentWaitBody,
  opts?: { sockPath?: string; timeoutMs?: number },
): Promise<
  WorkerApiResult & { status?: string; summary?: string; sessionKey?: string }
> {
  return workerApiRequest("/v1/agents/wait", body, {
    ...opts,
    timeoutMs: opts?.timeoutMs ?? 620_000,
  }) as Promise<
    WorkerApiResult & { status?: string; summary?: string; sessionKey?: string }
  >;
}
