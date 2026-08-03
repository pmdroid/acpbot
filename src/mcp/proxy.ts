/**
 * Stdio MCP proxy for a remote HTTP/SSE MCP gateway.
 *
 * Grok (and other agents) often mishandle remote OAuth MCP. acpbot instead:
 *  1. Loads / refreshes the Bearer token from the host store
 *  2. Connects as an MCP client to the remote URL
 *  3. Serves the same tools over **stdio** (what agents handle well)
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

async function connectRemote(
  url: string,
  stateDir: string,
  repoKey: string,
  id: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const authProvider: AuthProvider = {
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
      log.info("mcp-proxy: 401 — force-refreshing token", { id });
      await refreshStoredOAuthToken(stateDir, repoKey, id, {
        force: true,
        log,
      });
    },
  };

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider,
    // Prefer not to open interactive reauth from the proxy child.
    onInsufficientScope: "throw",
  });

  const client = new Client({
    name: `acpbot-proxy/${id}`,
    version: "0.1.0",
  });

  await client.connect(transport);
  return { client, transport };
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

/**
 * Entry for `acpbot mcp-proxy`. Blocks on stdio until the agent disconnects.
 */
export async function runMcpProxyMain(): Promise<void> {
  const id = envRequired("ACPBOT_MCP_PROXY_ID");
  const url = envRequired("ACPBOT_MCP_PROXY_URL");
  const stateDir = resolveOAuthStateDir(process.env.ACPBOT_STATE_DIR);
  const repoKey = envRequired("ACPBOT_REPO_KEY");

  log.info("mcp-proxy starting", { id, url, repoKey, stateDir });

  // Ensure we have a token before advertising tools
  const initial = await ensureFreshBearerForMcp(stateDir, repoKey, id, { log });
  if (!initial) {
    throw new Error(
      `mcp-proxy: no OAuth token for "${id}" (repo ${repoKey}). ` +
        `Run /mcp auth ${id} in Telegram first.`,
    );
  }

  let remote = await connectRemote(url, stateDir, repoKey, id);

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
        // Advertise upstream schema; accept any object at runtime
        inputSchema,
        input: z.record(z.string(), z.unknown()).optional(),
      },
      async (args) => {
        const payload =
          args && typeof args === "object" ? (args as Record<string, unknown>) : {};
        try {
          const result = await remote.client.callTool({
            name: toolName,
            arguments: payload,
          });
          return toolResultToText(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Reconnect once on auth-ish failures
          if (/401|unauthoriz|invalid_token|expired/i.test(msg)) {
            log.warn("mcp-proxy tool call auth failure; reconnecting", {
              tool: toolName,
              error: msg,
            });
            try {
              await remote.transport.close?.();
            } catch {
              /* */
            }
            try {
              await refreshStoredOAuthToken(stateDir, repoKey, id, {
                force: true,
                log,
              });
              remote = await connectRemote(url, stateDir, repoKey, id);
              const result = await remote.client.callTool({
                name: toolName,
                arguments: payload,
              });
              return toolResultToText(result);
            } catch (err2) {
              const m2 = err2 instanceof Error ? err2.message : String(err2);
              return (
                `Proxy tool ${toolName} failed after reauth: ${m2}. ` +
                `Run /mcp auth ${id} in Telegram if this persists.`
              );
            }
          }
          return `Proxy tool ${toolName} failed: ${msg}`;
        }
      },
    );
  }

  // Keep process alive serving stdio
  await server.run();
}
