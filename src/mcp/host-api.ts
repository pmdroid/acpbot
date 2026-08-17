/**
 * MCP → acp-host HTTP client (Unix socket).
 * Bearer token on every request including GET. Never put the token in the query string.
 */
import { request as httpRequest } from "node:http";
import { hostApiSockPath } from "../acp-host/host-api";

export type HostApiOk = {
  ok: true;
  action?: string;
  frameId?: string;
  width?: number;
  height?: number;
  jpegBase64?: string;
  status?: unknown;
  message?: string;
};
export type HostApiErr = { ok: false; error: string };
export type HostApiResult = HostApiOk | HostApiErr;

export async function hostApiRequest(
  path: string,
  body: unknown,
  opts?: {
    sockPath?: string;
    token?: string;
    timeoutMs?: number;
    method?: string;
  },
): Promise<HostApiResult> {
  const sockPath = opts?.sockPath ?? hostApiSockPath();
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const method = opts?.method ?? "POST";
  const token =
    opts?.token?.trim() || process.env.ACPBOT_HOST_API_TOKEN?.trim() || "";
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
          ...(token ? { authorization: `Bearer ${token}` } : {}),
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
            const json = JSON.parse(raw) as HostApiResult;
            if (json && typeof json === "object" && "ok" in json) {
              resolve(json);
              return;
            }
            resolve({
              ok: false,
              error: `invalid host-api response (${res.statusCode}): ${raw.slice(0, 200)}`,
            });
          } catch {
            resolve({
              ok: false,
              error: `host-api HTTP ${res.statusCode}: ${raw.slice(0, 200) || "(empty)"}`,
            });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({
        ok: false,
        error: `host API timed out after ${timeoutMs}ms (${path})`,
      });
    });
    req.on("error", (err) => {
      resolve({
        ok: false,
        error:
          `host API unreachable at ${sockPath}: ${err.message}. ` +
          `Is acp-host running?`,
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export async function hostComputerStatus(
  sessionKey: string,
  opts?: { sockPath?: string; token?: string },
): Promise<HostApiResult> {
  const q = new URLSearchParams({ sessionKey });
  return hostApiRequest(`/v1/computer/status?${q}`, undefined, {
    ...opts,
    method: "GET",
    timeoutMs: 5_000,
  });
}

export async function hostComputerAction(
  action: string,
  body: Record<string, unknown>,
  opts?: { sockPath?: string; token?: string; timeoutMs?: number },
): Promise<HostApiResult> {
  return hostApiRequest(`/v1/computer/${action}`, body, opts);
}
