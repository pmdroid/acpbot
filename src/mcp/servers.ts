/**
 * Build the mcpServers list for ACP session/new.
 * Kept pure / config-only so tests can assert shape without spawning.
 */
import { join } from "node:path";
import { workerApiSockPath } from "./worker-api";

/** ACP stdio MCP server descriptor (matches @agentclientprotocol/sdk McpServer). */
export type AcpbotMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

export type BuildAcpbotMcpServersOptions = {
  /**
   * When false, return []. Default true.
   * Set ACPBOT_MCP=0 to disable host MCP tools for the agent.
   */
  enabled?: boolean;
  /** Override absolute path to src/mcp/server.ts (tests). */
  serverEntry?: string;
  /** Override spawn command (default: process.execPath — bun when acpbot runs under bun). */
  command?: string;
  /** Extra env vars for the MCP child process. */
  env?: Array<{ name: string; value: string }>;
  /** acpbot sessionKey so outbound tools target the right Telegram topic. */
  sessionKey?: string;
  /** State dir for worker-api sock (defaults to ACPBOT_STATE_DIR). */
  stateDir?: string;
};

/** Absolute path to the FastMCP stdio entry. */
export function defaultAcpbotMcpServerEntry(): string {
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
    "ACPBOT_OPENAI_BASE_URL",
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
export function buildAcpbotMcpServers(
  options: BuildAcpbotMcpServersOptions = {},
): AcpbotMcpServer[] {
  const enabled =
    options.enabled ??
    (process.env.ACPBOT_MCP !== "0" && process.env.ACPBOT_MCP !== "false");
  if (!enabled) return [];

  const entry = options.serverEntry ?? defaultAcpbotMcpServerEntry();
  const command = options.command ?? process.execPath;
  const stateDir =
    options.stateDir?.trim() ||
    process.env.ACPBOT_STATE_DIR?.trim() ||
    "./data/acpbot-state";
  const sockPath = workerApiSockPath(stateDir);

  const env: Array<{ name: string; value: string }> = [
    { name: "ACPBOT_STATE_DIR", value: stateDir },
    { name: "ACPBOT_WORKER_API_SOCK", value: sockPath },
    ...speechEnvFromProcess(),
    ...(options.sessionKey
      ? [{ name: "ACPBOT_SESSION_KEY", value: options.sessionKey }]
      : []),
    ...(options.env ?? []),
  ];

  return [
    {
      name: "acpbot",
      command,
      args: [entry],
      env,
    },
  ];
}
