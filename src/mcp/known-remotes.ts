/**
 * Catalog of first-class remote MCP gateways (official URLs).
 * Used by sugar connect commands so operators need not copy-paste docs URLs.
 * Tokens still flow through generic MCP OAuth (`/mcp add` / `/mcp auth`).
 *
 * Empty for now — Linear was removed; add remotes here when a first-class
 * connect command is worth it. GitHub Issues is tracked via GitHub itself
 * (or a remote MCP added with `/mcp add`).
 */

export type KnownRemoteMcp = {
  /** Registry id written to `.acpbot/mcp.json`. */
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

const BY_ID: Record<string, KnownRemoteMcp> = {};

export function getKnownRemote(id: string): KnownRemoteMcp | undefined {
  return BY_ID[id.trim().toLowerCase()];
}

export function listKnownRemotes(): KnownRemoteMcp[] {
  return Object.values(BY_ID);
}
