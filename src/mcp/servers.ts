/**
 * Build the mcpServers list for ACP session/new.
 * Kept pure / config-only so tests can assert shape without spawning.
 */
import { join } from "node:path";
import { workerApiSockPath } from "./worker-api";

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
  /** tacp sessionKey so outbound tools target the right Telegram topic. */
  sessionKey?: string;
  /** State dir for worker-api sock (defaults to TACP_STATE_DIR). */
  stateDir?: string;
};

/** Absolute path to the FastMCP stdio entry. */
export function defaultTacpMcpServerEntry(): string {
  return join(import.meta.dir, "server.ts");
}

/** Forward speech-related env so MCP-side tooling can use the same keys if needed. */
function speechEnvFromProcess(
  env: NodeJS.ProcessEnv = process.env,
): Array<{ name: string; value: string }> {
  const keys = [
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_VOICE_ID",
    "ELEVENLABS_TTS_MODEL",
    "ELEVENLABS_BASE_URL",
    "OPENAI_API_KEY",
    "TACP_OPENAI_BASE_URL",
  ];
  const out: Array<{ name: string; value: string }> = [];
  for (const k of keys) {
    const v = env[k]?.trim();
    if (v) out.push({ name: k, value: v });
  }
  return out;
}

/**
 * Host MCP servers exposed to an ACP session.
 * Outbound tools call the worker Unix API (sessionKey + sock path in env).
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
  const stateDir =
    options.stateDir?.trim() ||
    process.env.TACP_STATE_DIR?.trim() ||
    "./data/tacp-state";
  const sockPath = workerApiSockPath(stateDir);

  const env: Array<{ name: string; value: string }> = [
    { name: "TACP_STATE_DIR", value: stateDir },
    { name: "TACP_WORKER_API_SOCK", value: sockPath },
    ...speechEnvFromProcess(),
    ...(options.sessionKey
      ? [{ name: "TACP_SESSION_KEY", value: options.sessionKey }]
      : []),
    ...(options.env ?? []),
  ];

  return [
    {
      name: "tacp",
      command,
      args: [entry],
      env,
    },
  ];
}
