/**
 * OpenAI-compatible HTTP gateway (host process).
 * Auth: Authorization: Bearer <token>
 * Default bind 127.0.0.1 — not for public internet without a tunnel + token.
 */
import type { Logger } from "../env/logger";
import type { ChatHost } from "../chat/turn";
import { buildModelCatalog } from "./models";
import { runCompletion } from "./completions";
import type { OpenAiChatCompletionRequest } from "./types";

export type OpenAiGatewayConfig = {
  enabled: boolean;
  listenHost: string;
  listenPort: number;
  token: string;
  defaultRepo?: string;
  permissionMode: "ask" | "bypass";
  agents?: string[];
  repos?: string[];
};

export type OpenAiGatewayOptions = {
  config: OpenAiGatewayConfig;
  host: ChatHost;
  repos: Record<string, string>;
  defaultAgent: string;
  log?: Logger;
};

export type OpenAiGatewayHandle = {
  url: string;
  close: () => Promise<void>;
};

export function parseOpenAiGatewayToml(
  raw: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OpenAiGatewayConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const enabled =
    raw.enabled === true ||
    raw.enabled === "true" ||
    raw.enabled === 1 ||
    env.ACPBOT_OPENAI_GATEWAY === "1";
  if (!enabled && raw.enabled !== false) {
    // only return config if table present with enabled or env
    if (env.ACPBOT_OPENAI_GATEWAY !== "1") return undefined;
  }
  if (raw.enabled === false || raw.enabled === "false") return undefined;

  const token =
    String(raw.token ?? env.ACPBOT_OPENAI_GATEWAY_TOKEN ?? "").trim() ||
    String(env.ACPBOT_OPENAI_GATEWAY_TOKEN ?? "").trim();
  // env:TOKEN form
  let resolved = token;
  if (token.startsWith("env:")) {
    resolved = String(env[token.slice(4)] ?? "").trim();
  }

  const listenHost = String(
    raw.listen_host ?? raw.listenHost ?? "127.0.0.1",
  ).trim();
  const listenPort = Number(raw.listen_port ?? raw.listenPort ?? 8791);
  const permissionMode =
    String(raw.permission_mode ?? raw.permissionMode ?? "bypass").toLowerCase() ===
    "ask"
      ? "ask"
      : "bypass";
  const defaultRepo = String(
    raw.default_repo ?? raw.defaultRepo ?? "",
  ).trim() || undefined;
  const agents = Array.isArray(raw.agents)
    ? raw.agents.map((a) => String(a).trim()).filter(Boolean)
    : undefined;
  const repos = Array.isArray(raw.repos)
    ? raw.repos.map((a) => String(a).trim()).filter(Boolean)
    : undefined;

  if (!resolved) {
    throw new Error(
      "[openai_gateway] enabled but token is empty — set token or ACPBOT_OPENAI_GATEWAY_TOKEN",
    );
  }

  return {
    enabled: true,
    listenHost,
    listenPort: Number.isFinite(listenPort) ? listenPort : 8791,
    token: resolved,
    permissionMode,
    ...(defaultRepo ? { defaultRepo } : {}),
    ...(agents?.length ? { agents } : {}),
    ...(repos?.length ? { repos } : {}),
  };
}

export async function startOpenAiGateway(
  opts: OpenAiGatewayOptions,
): Promise<OpenAiGatewayHandle> {
  const { config, host, repos, defaultAgent, log } = opts;
  const catalog = buildModelCatalog({
    repos,
    defaultAgent,
    ...(config.agents ? { agents: config.agents } : {}),
    ...(config.repos ? { repoKeys: config.repos } : {}),
  });

  const server = Bun.serve({
    hostname: config.listenHost,
    port: config.listenPort,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/health" || path === "/v1/health") {
        return Response.json({ ok: true, service: "acpbot-openai-gateway" });
      }

      if (!checkAuth(req, config.token)) {
        return Response.json(
          { error: { message: "Unauthorized", type: "auth_error" } },
          { status: 401 },
        );
      }

      if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
        return Response.json({ object: "list", data: catalog });
      }

      if (
        req.method === "POST" &&
        (path === "/v1/chat/completions" || path === "/chat/completions")
      ) {
        let body: OpenAiChatCompletionRequest;
        try {
          body = (await req.json()) as OpenAiChatCompletionRequest;
        } catch {
          return Response.json(
            { error: { message: "invalid JSON body" } },
            { status: 400 },
          );
        }
        const ac = new AbortController();
        req.signal.addEventListener("abort", () => ac.abort(), { once: true });
        return runCompletion(
          {
            host,
            repos,
            defaultAgent,
            permissionMode: config.permissionMode,
            ...(config.defaultRepo ? { defaultRepo: config.defaultRepo } : {}),
          },
          body,
          ac.signal,
        );
      }

      return Response.json(
        { error: { message: `not found: ${path}` } },
        { status: 404 },
      );
    },
  });

  const url = `http://${config.listenHost}:${server.port}`;
  log?.info("openai gateway listening", {
    url,
    models: catalog.length,
    permissionMode: config.permissionMode,
  });

  return {
    url,
    close: async () => {
      server.stop(true);
    },
  };
}

function checkAuth(req: Request, token: string): boolean {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return false;
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1]!.trim() === token;
}
