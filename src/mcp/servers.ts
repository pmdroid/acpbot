/**
 * Build the mcpServers list passed into acpx createAcpRuntime.
 * Kept pure / config-only so tests can assert shape without spawning.
 */
import { join } from "node:path";

/** ACP stdio MCP server descriptor (matches @agentclientprotocol/sdk McpServer). */
export type TacpMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

export type BuildTacpMcpServersOptions = {
  /**
   * When false, return []. Default true.
   * Set TACP_MCP=0 to disable host MCP tools for the agent.
   */
  enabled?: boolean;
  /** Override absolute path to src/mcp/server.ts (tests). */
  serverEntry?: string;
  /** Override spawn command (default: process.execPath — bun when tacp runs under bun). */
  command?: string;
  /** Extra env vars for the MCP child process. */
  env?: Array<{ name: string; value: string }>;
};

/** Absolute path to the FastMCP stdio entry. */
export function defaultTacpMcpServerEntry(): string {
  return join(import.meta.dir, "server.ts");
}

/**
 * Host MCP servers exposed to every ACP session created by tacp.
 * speak (TTS) now; STT later.
 */
export function buildTacpMcpServers(
  options: BuildTacpMcpServersOptions = {},
): TacpMcpServer[] {
  const enabled =
    options.enabled ??
    (process.env.TACP_MCP !== "0" && process.env.TACP_MCP !== "false");
  if (!enabled) return [];

  const entry = options.serverEntry ?? defaultTacpMcpServerEntry();
  const command = options.command ?? process.execPath;

  return [
    {
      name: "tacp",
      command,
      args: [entry],
      env: options.env ?? [],
    },
  ];
}
