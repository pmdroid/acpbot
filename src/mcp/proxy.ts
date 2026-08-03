/**
 * Stdio MCP proxy for a remote HTTP/SSE MCP gateway.
 *
 * Why: agents (especially Grok) mishandle remote OAuth MCP. Restarting the
 * agent on every reauth is a bad UX. Instead:
 *
 *   Agent  ──stdio──►  acpbot mcp-proxy  ──HTTP + Bearer──►  remote gateway
 *
 * Auth lives entirely in acpbot:
 *  - token() re-reads the host store every request (picks up /mcp auth)
 *  - 401 → force-refresh and retry (no agent process kill)
 *
 * Env (set by session-host when rewriting remotes):
 *   ACPBOT_MCP_PROXY_ID      gateway id (token store key)
 *   ACPBOT_MCP_PROXY_URL     remote MCP URL
 *   ACPBOT_STATE_DIR         token store root
 *   ACPBOT_REPO_KEY          repo key for token path
 *   ACPBOT_MCP_PROXY_TYPE    "http" | "sse" (default http / streamable)
 */
import { FastMCP } from "@prefecthq/fastmcp-ts/server";
import { z } from "zod";
import {
  Client,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import {
  ensureFreshBearerForMcp,
  refreshStoredOAuthToken,
} from "./oauth-flow";
import { resolveOAuthStateDir } from "./oauth-store";
import { createLogger } from "../env/logger";

const log = createLogger({ level: "info", name: "acpbot-mcp-proxy" });

/** Strip "Bearer " if present — AuthProvider wants the raw token. */
function rawToken(bearerHeader: string): string {
  const t = bearerHeader.trim();
  if (/^bearer\s+/i.test(t)) return t.replace(/^bearer\s+/i, "").trim();
  return t;
}

function envRequired(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`mcp-proxy: missing env ${name}`);
  return v;
}

type RemoteConn = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

async function connectRemote(
  url: string,
  stateDir: string,
  repoKey: string,
  id: string,
): Promise<RemoteConn> {
  const authProvider: AuthProvider = {
    // Always re-read store so a mid-session /mcp auth is visible without
    // restarting the agent (or this proxy process).
    async token() {
      const auth = await ensureFreshBearerForMcp(stateDir, repoKey, id, {
        log,
      });
      if (!auth) {
        log.warn("mcp-proxy: no OAuth token", { id, repoKey });
        return undefined;
      }
      return rawToken(auth.value);
    },
    async onUnauthorized() {
      log.info("mcp-proxy: 401 — force-refreshing token (agent stays up)", {
        id,
      });
      await refreshStoredOAuthToken(stateDir, repoKey, id, {
        force: true,
        log,
      });
    },
  };

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider,
    onInsufficientScope: "throw",
  });

  const client = new Client({
    name: `acpbot-proxy/${id}`,
    version: "0.1.0",
  });

  await client.connect(transport);
  return { client, transport };
}

async function closeRemote(remote: RemoteConn | null): Promise<void> {
  if (!remote) return;
  try {
    await remote.transport.close?.();
  } catch {
    /* */
  }
}

function toolResultToText(result: CallToolResult): string {
  if (!result?.content || !Array.isArray(result.content)) {
    return JSON.stringify(result ?? null);
  }
  const parts: string[] = [];
  for (const block of result.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else {
      parts.push(JSON.stringify(b));
    }
  }
  if (result.isError) {
    return parts.length ? `Error: ${parts.join("\n")}` : "Tool error (no detail)";
  }
  return parts.join("\n") || "(empty tool result)";
}

function looksLikeAuthFailure(msg: string): boolean {
  return /401|unauthoriz|invalid_token|expired|forbidden|auth/i.test(msg);
}

/**
 * Entry for `acpbot mcp-proxy`. Blocks on stdio until the agent disconnects.
 * Never requires the agent process to restart for token refresh.
 */
export async function runMcpProxyMain(): Promise<void> {
  const id = envRequired("ACPBOT_MCP_PROXY_ID");
  const url = envRequired("ACPBOT_MCP_PROXY_URL");
  const stateDir = resolveOAuthStateDir(process.env.ACPBOT_STATE_DIR);
  const repoKey = envRequired("ACPBOT_REPO_KEY");

  log.info("mcp-proxy starting", { id, url, repoKey, stateDir });

  const initial = await ensureFreshBearerForMcp(stateDir, repoKey, id, { log });
  if (!initial) {
    throw new Error(
      `mcp-proxy: no OAuth token for "${id}" (repo ${repoKey}). ` +
        `Run /mcp auth ${id} in Telegram first.`,
    );
  }

  // Mutable remote connection — reconnected in-process on auth failures.
  let remote: RemoteConn = await connectRemote(url, stateDir, repoKey, id);
  let connectLock: Promise<void> | null = null;

  async function ensureRemote(): Promise<RemoteConn> {
    if (connectLock) {
      await connectLock;
      return remote;
    }
    return remote;
  }

  async function reconnectRemote(reason: string): Promise<RemoteConn> {
    if (connectLock) {
      await connectLock;
      return remote;
    }
    connectLock = (async () => {
      log.info("mcp-proxy reconnecting remote (agent still up)", {
        id,
        reason,
      });
      await closeRemote(remote);
      try {
        await refreshStoredOAuthToken(stateDir, repoKey, id, {
          force: true,
          log,
        });
      } catch (err) {
        // Token may already be fresh from /mcp auth — still reconnect.
        log.warn("mcp-proxy force-refresh skipped", {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      remote = await connectRemote(url, stateDir, repoKey, id);
    })();
    try {
      await connectLock;
    } finally {
      connectLock = null;
    }
    return remote;
  }

  const list = await remote.client.listTools();
  const tools = list.tools ?? [];
  log.info("mcp-proxy remote tools", {
    id,
    count: tools.length,
    names: tools.map((t) => t.name).slice(0, 40),
  });

  const server = new FastMCP({
    name: id,
    version: "0.1.0",
  });

  for (const t of tools) {
    const toolName = t.name;
    const description =
      typeof t.description === "string" && t.description.trim()
        ? t.description
        : `Proxied tool ${toolName} (via acpbot MCP proxy → ${id})`;
    const inputSchema =
      t.inputSchema && typeof t.inputSchema === "object"
        ? (t.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} };

    server.tool(
      {
        name: toolName,
        description,
        inputSchema,
        input: z.record(z.string(), z.unknown()).optional(),
      },
      async (args) => {
        const payload =
          args && typeof args === "object"
            ? (args as Record<string, unknown>)
            : {};

        const callOnce = async (conn: RemoteConn) => {
          const result = await conn.client.callTool({
            name: toolName,
            arguments: payload,
          });
          return toolResultToText(result);
        };

        try {
          const conn = await ensureRemote();
          return await callOnce(conn);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!looksLikeAuthFailure(msg)) {
            return `Proxy tool ${toolName} failed: ${msg}`;
          }
          // Auth failure: refresh + reconnect proxy→remote only. Agent stays.
          try {
            const conn = await reconnectRemote(msg);
            return await callOnce(conn);
          } catch (err2) {
            const m2 = err2 instanceof Error ? err2.message : String(err2);
            return (
              `Proxy tool ${toolName} failed after token refresh: ${m2}. ` +
              `Run /mcp auth ${id} in Telegram if this persists ` +
              `(no agent restart required once authorized).`
            );
          }
        }
      },
    );
  }

  await server.run();
}
