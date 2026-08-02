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
