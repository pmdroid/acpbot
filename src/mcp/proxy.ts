/**
 * Stdio MCP proxy for a remote HTTP/SSE MCP gateway (one process per slot).
 *
 *   Agent  ──stdio──►  acpbot mcp-proxy  ──HTTP + Bearer──►  remote
 *
 * - Starts even with **no OAuth token** (empty tool list) so the agent always
 *   has the proxy attached; when `/mcp auth` completes, we connect and
 *   re-advertise tools via list_changed (no agent restart).
 * - token() re-reads the store every request; 401 force-refreshes.
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

const TOKEN_POLL_MS = 5_000;

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

type RemoteTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

async function connectRemote(
  url: string,
  stateDir: string,
  repoKey: string,
  id: string,
): Promise<RemoteConn> {
  const authProvider: AuthProvider = {
    async token() {
      const auth = await ensureFreshBearerForMcp(stateDir, repoKey, id, {
        log,
      });
      if (!auth) return undefined;
      return rawToken(auth.value);
    },
    async onUnauthorized() {
      log.info("mcp-proxy: 401 — force-refresh (agent stays up)", { id });
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
 */
export async function runMcpProxyMain(): Promise<void> {
  const id = envRequired("ACPBOT_MCP_PROXY_ID");
  const url = envRequired("ACPBOT_MCP_PROXY_URL");
  const stateDir = resolveOAuthStateDir(process.env.ACPBOT_STATE_DIR);
  const repoKey = envRequired("ACPBOT_REPO_KEY");
  const sessionKey = process.env.ACPBOT_SESSION_KEY?.trim() || undefined;

  log.info("mcp-proxy starting (per-slot)", {
    id,
    url,
    repoKey,
    stateDir,
    sessionKey,
  });

  const server = new FastMCP({
    name: id,
    version: "0.1.0",
  });

  // Mutable remote connection — may be null until first successful auth.
  let remote: RemoteConn | null = null;
  let connectLock: Promise<void> | null = null;
  const registeredTools = new Set<string>();

  async function registerTools(tools: RemoteTool[]): Promise<void> {
    for (const t of tools) {
      if (registeredTools.has(t.name)) continue;
      const toolName = t.name;
      const description =
        typeof t.description === "string" && t.description.trim()
          ? t.description
          : `Proxied tool ${toolName} (via acpbot → ${id})`;
      const inputSchema =
        t.inputSchema && typeof t.inputSchema === "object"
          ? t.inputSchema
          : { type: "object", properties: {} };

      server.tool(
        {
          name: toolName,
          description,
          inputSchema,
          input: z.record(z.string(), z.unknown()).optional(),
        },
        async (args) => callProxiedTool(toolName, args),
      );
      registeredTools.add(toolName);
    }
    // Notify agent that tools/list changed (when supported).
    try {
      const notify = (
        server as unknown as { _notifyToolListChanged?: () => void }
      )._notifyToolListChanged;
      notify?.call(server);
    } catch {
      /* best-effort */
    }
  }

  async function reconnectRemote(reason: string): Promise<RemoteConn> {
    if (connectLock) {
      await connectLock;
      if (!remote) throw new Error("mcp-proxy: not connected");
      return remote;
    }
    connectLock = (async () => {
      log.info("mcp-proxy connecting/reconnecting remote", { id, reason });
      await closeRemote(remote);
      remote = null;
      try {
        await refreshStoredOAuthToken(stateDir, repoKey, id, {
          force: reason.includes("401"),
          log,
        });
      } catch {
        /* may already be fresh or missing */
      }
      remote = await connectRemote(url, stateDir, repoKey, id);
      const list = await remote.client.listTools();
      const tools = (list.tools ?? []) as RemoteTool[];
      log.info("mcp-proxy remote tools", {
        id,
        count: tools.length,
        names: tools.map((t) => t.name).slice(0, 40),
      });
      await registerTools(tools);
    })();
    try {
      await connectLock;
    } finally {
      connectLock = null;
    }
    if (!remote) throw new Error("mcp-proxy: connect failed");
    return remote;
  }

  async function callProxiedTool(
    toolName: string,
    args: unknown,
  ): Promise<string> {
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
      if (!remote) {
        await reconnectRemote("lazy-connect");
      }
      return await callOnce(remote!);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!looksLikeAuthFailure(msg) && remote) {
        return `Proxy tool ${toolName} failed: ${msg}`;
      }
      try {
        const conn = await reconnectRemote(msg);
        return await callOnce(conn);
      } catch (err2) {
        const m2 = err2 instanceof Error ? err2.message : String(err2);
        return (
          `Proxy tool ${toolName} failed: ${m2}. ` +
          `Run /mcp auth ${id} if unauthorized (no agent restart required).`
        );
      }
    }
  }

  // Prefer connect now if token exists; otherwise serve empty tools and poll.
  const initial = await ensureFreshBearerForMcp(stateDir, repoKey, id, {
    log,
  }).catch(() => undefined);

  if (initial) {
    try {
      await reconnectRemote("boot");
    } catch (err) {
      log.warn("mcp-proxy boot connect failed; serving empty tools", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.info(
      "mcp-proxy: no token yet — empty tools until /mcp auth (agent stays attached)",
      { id, repoKey },
    );
  }

  // Background: when unauthed at start, pick up token without agent restart.
  const poll = setInterval(() => {
    void (async () => {
      if (remote || connectLock) return;
      const auth = await ensureFreshBearerForMcp(stateDir, repoKey, id, {
        log,
      }).catch(() => undefined);
      if (!auth) return;
      try {
        await reconnectRemote("token-appeared");
      } catch (err) {
        log.warn("mcp-proxy poll connect failed", {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, TOKEN_POLL_MS);
  poll.unref?.();

  await server.run();
  clearInterval(poll);
  await closeRemote(remote);
}
