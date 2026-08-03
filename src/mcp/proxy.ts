/**
 * Stdio MCP proxy for a remote OAuth HTTP MCP gateway (one process per slot).
 *
 * Built entirely on the official Model Context Protocol TypeScript SDK:
 *
 *   Agent  ──stdio──►  McpServer (this process)
 *                         │
 *                         └─ Client + StreamableHTTPClientTransport
 *                              ──HTTP + Bearer──►  remote gateway
 *
 * - Attaches even with **no OAuth token** (empty tools) so the agent always
 *   has the proxy; when `/mcp auth` completes, we connect and send
 *   `tools/list_changed` (no agent restart).
 * - `AuthProvider.token()` re-reads the host store every request; 401
 *   force-refreshes via `onUnauthorized`.
 */
import {
  Client,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import {
  fromJsonSchema,
  McpServer,
  type RegisteredTool,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
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

function looksLikeAuthOrSessionFailure(msg: string): boolean {
  return /401|403|unauthoriz|invalid_token|expired|forbidden|auth|session|mcp-session|not connected|ECONNRESET|EPIPE|fetch failed|network/i.test(
    msg,
  );
}

function emptyObjectSchema(): ReturnType<typeof fromJsonSchema> {
  return fromJsonSchema({
    type: "object",
    properties: {},
    additionalProperties: true,
  });
}

function schemaForTool(
  inputSchema: Record<string, unknown> | undefined,
): ReturnType<typeof fromJsonSchema> {
  if (inputSchema && typeof inputSchema === "object") {
    try {
      return fromJsonSchema(inputSchema as Parameters<typeof fromJsonSchema>[0]);
    } catch (err) {
      log.warn("mcp-proxy: inputSchema convert failed; using open object", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return emptyObjectSchema();
}

function errorToolResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
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

  log.info("mcp-proxy starting (official SDK, per-slot)", {
    id,
    url,
    repoKey,
    stateDir,
    sessionKey,
  });

  const server = new McpServer(
    { name: id, version: "0.1.0" },
    {
      capabilities: {
        tools: { listChanged: true },
      },
    },
  );

  let remote: RemoteConn | null = null;
  let connectLock: Promise<void> | null = null;
  /** tool name → registration handle (for remove / re-register) */
  const registered = new Map<string, RegisteredTool>();

  async function connectRemote(): Promise<RemoteConn> {
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

  async function closeRemote(conn: RemoteConn | null): Promise<void> {
    if (!conn) return;
    try {
      await conn.client.close?.();
    } catch {
      /* */
    }
    try {
      await conn.transport.close?.();
    } catch {
      /* */
    }
  }

  async function callProxiedTool(
    toolName: string,
    args: unknown,
  ): Promise<CallToolResult> {
    const payload =
      args && typeof args === "object"
        ? (args as Record<string, unknown>)
        : {};

    const callOnce = async (conn: RemoteConn): Promise<CallToolResult> => {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: payload,
      });
      // Pass remote content blocks through (text / image / …).
      return {
        content: Array.isArray(result.content) ? result.content : [],
        ...(result.isError ? { isError: true } : {}),
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
      } as CallToolResult;
    };

    try {
      if (!remote) {
        await reconnectRemote("lazy-connect");
      }
      return await callOnce(remote!);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!looksLikeAuthOrSessionFailure(msg) && remote) {
        return errorToolResult(`Proxy tool ${toolName} failed: ${msg}`);
      }
      try {
        const conn = await reconnectRemote(msg);
        return await callOnce(conn);
      } catch (err2) {
        const m2 = err2 instanceof Error ? err2.message : String(err2);
        return errorToolResult(
          `Proxy tool ${toolName} failed: ${m2}. ` +
            `Run /mcp auth ${id} if unauthorized (no agent restart required).`,
        );
      }
    }
  }

  function registerTools(tools: RemoteTool[]): void {
    let added = 0;
    for (const t of tools) {
      if (registered.has(t.name)) continue;
      const toolName = t.name;
      const description =
        typeof t.description === "string" && t.description.trim()
          ? t.description
          : `Proxied tool ${toolName} (via acpbot → ${id})`;
      const inputSchema = schemaForTool(
        t.inputSchema && typeof t.inputSchema === "object"
          ? t.inputSchema
          : undefined,
      );

      const handle = server.registerTool(
        toolName,
        {
          description,
          inputSchema,
        },
        async (args) => callProxiedTool(toolName, args),
      );
      registered.set(toolName, handle);
      added++;
    }
    if (added > 0 && server.isConnected()) {
      try {
        server.sendToolListChanged();
      } catch {
        /* best-effort — agent may not support listChanged */
      }
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
          force: /401|unauthoriz|invalid_token/i.test(reason),
          log,
        });
      } catch {
        /* may already be fresh or missing */
      }
      remote = await connectRemote();
      const list = await remote.client.listTools();
      const tools = (list.tools ?? []) as RemoteTool[];
      log.info("mcp-proxy remote tools", {
        id,
        count: tools.length,
        names: tools.map((t) => t.name).slice(0, 40),
      });
      registerTools(tools);
    })();
    try {
      await connectLock;
    } finally {
      connectLock = null;
    }
    if (!remote) throw new Error("mcp-proxy: connect failed");
    return remote;
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("mcp-proxy stdio connected (official McpServer)", {
    id,
    tools: registered.size,
  });

  // Stay alive until stdin closes / transport ends.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on("end", () => resolve());
    process.stdin.on("close", () => resolve());
  });

  clearInterval(poll);
  await closeRemote(remote);
  try {
    await server.close();
  } catch {
    /* */
  }
}
