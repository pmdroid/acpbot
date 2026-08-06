/**
 * Catalog of first-class remote MCP gateways (official URLs).
 * Used by sugar commands like `/linear connect` so operators need not
 * copy-paste docs URLs. Tokens still flow through generic MCP OAuth.
 */

export type KnownRemoteMcp = {
  /** Registry id written to `.acpbot/mcp.json` (e.g. "linear"). */
  id: string;
  /** Human label. */
  label: string;
  /** Default read-write Streamable HTTP MCP URL. */
  url: string;
  /** Optional read-only URL when the gateway offers one. */
  readonlyUrl?: string;
  /** One-line help for connect success messages. */
  summary: string;
};

export const LINEAR_MCP_ID = "linear";

/** Official Linear remote MCP (OAuth 2.1 + DCR). */
export const LINEAR_MCP: KnownRemoteMcp = {
  id: LINEAR_MCP_ID,
  label: "Linear",
  url: "https://mcp.linear.app/mcp",
  readonlyUrl: "https://mcp.linear.app/mcp/readonly",
  summary:
    "Linear issues, projects, and comments via official remote MCP (OAuth).",
};

const BY_ID: Record<string, KnownRemoteMcp> = {
  [LINEAR_MCP_ID]: LINEAR_MCP,
};

export function getKnownRemote(id: string): KnownRemoteMcp | undefined {
  return BY_ID[id.trim().toLowerCase()];
}

export function listKnownRemotes(): KnownRemoteMcp[] {
  return Object.values(BY_ID);
}
