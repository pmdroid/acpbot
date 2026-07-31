/**
 * Load per-repo MCP servers from `<repo>/.tacp/mcp.json`.
 * Resolve relative paths from repo root; reject path escapes outside the repo.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import {
  buildTacpMcpServers,
  type BuildTacpMcpServersOptions,
  type TacpMcpServer,
} from "./servers";

/** ACP-compatible remote MCP (http/sse) — passed through when present. */
export type TacpMcpRemoteServer = {
  type: "http" | "sse";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
};

/** Stdio or remote MCP descriptor for a session. */
export type SessionMcpServer = TacpMcpServer | TacpMcpRemoteServer;

export type LoadRepoMcpServersOptions = {
  log?: Logger;
  /** Override path to mcp.json (tests). Default: `<repoRoot>/.tacp/mcp.json`. */
  configPath?: string;
};

export type BuildSessionMcpServersOptions = BuildTacpMcpServersOptions & {
  /** Absolute (or resolvable) repo root / session cwd. */
  cwd: string;
  log?: Logger;
  /** Override path to mcp.json (tests). */
  configPath?: string;
};

/** True when token looks like a filesystem path (not a bare PATH binary). */
export function isPathLikeToken(token: string): boolean {
  if (!token) return false;
  if (token.startsWith(".") || token.startsWith("/") || token.startsWith("~")) {
    return true;
  }
  return token.includes("/") || token.includes("\\");
}

/**
 * Whether `candidate` (absolute) lies inside `repoRoot` (inclusive).
 * Uses resolved normalized paths; rejects `..` escapes outside the repo.
 */
export function isWithinRepo(repoRoot: string, candidate: string): boolean {
  const root = resolve(repoRoot);
  const abs = resolve(candidate);
  if (abs === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return abs.startsWith(prefix);
}

/**
 * Resolve a path-like token against repo root.
 * Relative tokens resolve from repo root; absolute kept as-is.
 * Throws if the result escapes outside the repo.
 *
 * Bare tokens (no path separators / not path-like) are returned unchanged
 * and are not subject to escape checks (PATH binaries like `bun`, `npx`).
 */
export function resolveRepoPathToken(repoRoot: string, token: string): string {
  if (!isPathLikeToken(token)) return token;

  const root = resolve(repoRoot);
  let abs: string;
  if (isAbsolute(token)) {
    abs = resolve(normalize(token));
  } else {
    abs = resolve(root, token);
  }

  if (!isWithinRepo(root, abs)) {
    throw new Error(
      `path escapes repo root: ${token} → ${abs} (repo: ${root})`,
    );
  }
  return abs;
}

function envObjectToArray(
  env: unknown,
): Array<{ name: string; value: string }> {
  if (env == null) return [];
  if (Array.isArray(env)) {
    const out: Array<{ name: string; value: string }> = [];
    for (const entry of env) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.name === "string" && typeof rec.value === "string") {
        out.push({ name: rec.name, value: rec.value });
      }
    }
    return out;
  }
  if (typeof env === "object") {
    const out: Array<{ name: string; value: string }> = [];
    for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value === "string") {
        out.push({ name, value });
      } else if (value != null) {
        out.push({ name, value: String(value) });
      }
    }
    return out;
  }
  return [];
}

function headersToArray(
  headers: unknown,
): Array<{ name: string; value: string }> {
  if (headers == null) return [];
  if (Array.isArray(headers)) {
    return envObjectToArray(headers);
  }
  if (typeof headers === "object") {
    return envObjectToArray(headers);
  }
  return [];
}

function parseOneServer(
  raw: unknown,
  repoRoot: string,
  index: number,
  log: Logger,
): SessionMcpServer | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    log.warn("repo mcp: skip non-object server entry", { index });
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) {
    log.warn("repo mcp: skip server without name", { index });
    return undefined;
  }

  const typeRaw =
    typeof rec.type === "string" ? rec.type.trim().toLowerCase() : undefined;

  if (typeRaw === "http" || typeRaw === "sse") {
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!url) {
      log.warn("repo mcp: skip remote server without url", { index, name });
      return undefined;
    }
    return {
      type: typeRaw,
      name,
      url,
      headers: headersToArray(rec.headers),
    };
  }

  // stdio (default): command + optional args/env
  if (typeRaw != null && typeRaw !== "stdio") {
    log.warn("repo mcp: skip unsupported server type", {
      index,
      name,
      type: typeRaw,
    });
    return undefined;
  }

  const commandRaw = typeof rec.command === "string" ? rec.command.trim() : "";
  if (!commandRaw) {
    log.warn("repo mcp: skip stdio server without command", { index, name });
    return undefined;
  }

  try {
    const command = resolveRepoPathToken(repoRoot, commandRaw);
    const argsRaw = Array.isArray(rec.args) ? rec.args : [];
    const args: string[] = [];
    for (const a of argsRaw) {
      if (typeof a !== "string") {
        throw new Error(`non-string arg in server ${name}`);
      }
      args.push(resolveRepoPathToken(repoRoot, a));
    }
    return {
      name,
      command,
      args,
      env: envObjectToArray(rec.env),
    };
  } catch (err) {
    log.warn("repo mcp: reject server (path safety)", {
      index,
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Read `<repoRoot>/.tacp/mcp.json` and return parsed servers.
 * Missing file → []; invalid JSON → warn + [].
 */
export async function loadRepoMcpServers(
  repoRoot: string,
  options: LoadRepoMcpServersOptions = {},
): Promise<SessionMcpServer[]> {
  const log = options.log ?? silentLogger();
  const root = resolve(repoRoot);
  const configPath =
    options.configPath ?? join(root, ".tacp", "mcp.json");

  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === "ENOENT") return [];
    log.warn("repo mcp: failed to read mcp.json", {
      configPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    log.warn("repo mcp: invalid JSON in mcp.json; using built-in only", {
      configPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("repo mcp: mcp.json root must be an object", { configPath });
    return [];
  }

  const list = (parsed as { mcpServers?: unknown }).mcpServers;
  if (list == null) return [];
  if (!Array.isArray(list)) {
    log.warn("repo mcp: mcpServers must be an array", { configPath });
    return [];
  }

  const out: SessionMcpServer[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = parseOneServer(list[i], root, i, log);
    if (s) out.push(s);
  }
  return out;
}

function isStdioServer(s: SessionMcpServer): s is TacpMcpServer {
  return !("type" in s) || (s as { type?: string }).type === undefined;
}

/** Inject session/repo identity into stdio MCP child env. */
export function injectSessionEnv(
  server: SessionMcpServer,
  input: {
    sessionKey?: string;
    repoRoot: string;
    /** Per-repo state dir (`<cwd>/.tacp`). */
    repoStateDir: string;
  },
): SessionMcpServer {
  if (!isStdioServer(server)) return server;

  const envMap = new Map(server.env.map((e) => [e.name, e.value]));
  if (input.sessionKey) {
    envMap.set("TACP_SESSION_KEY", input.sessionKey);
  }
  envMap.set("TACP_REPO_ROOT", resolve(input.repoRoot));
  envMap.set("TACP_STATE_DIR", resolve(input.repoStateDir));

  return {
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: [...envMap.entries()].map(([name, value]) => ({ name, value })),
  };
}

/**
 * Merge order: **repo MCP first**, then **built-in tacp** (speak).
 * Missing/invalid repo config → built-in only.
 * Injects TACP_SESSION_KEY / TACP_REPO_ROOT / TACP_STATE_DIR into every stdio child.
 */
export async function buildSessionMcpServers(
  options: BuildSessionMcpServersOptions,
): Promise<SessionMcpServer[]> {
  const enabled =
    options.enabled ??
    (process.env.TACP_MCP !== "0" && process.env.TACP_MCP !== "false");
  if (!enabled) return [];

  const repoRoot = resolve(options.cwd);
  const repoStateDir = join(repoRoot, ".tacp");
  const log = options.log ?? silentLogger();

  const repo = await loadRepoMcpServers(repoRoot, {
    log,
    ...(options.configPath !== undefined
      ? { configPath: options.configPath }
      : {}),
  });

  const tacp = buildTacpMcpServers({
    enabled: true,
    ...(options.serverEntry !== undefined
      ? { serverEntry: options.serverEntry }
      : {}),
    ...(options.command !== undefined ? { command: options.command } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.sessionKey !== undefined
      ? { sessionKey: options.sessionKey }
      : {}),
    ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
  });

  const injectCtx: {
    sessionKey?: string;
    repoRoot: string;
    repoStateDir: string;
  } = {
    repoRoot,
    repoStateDir,
  };
  if (options.sessionKey !== undefined) {
    injectCtx.sessionKey = options.sessionKey;
  }

  return [
    ...repo.map((s) => injectSessionEnv(s, injectCtx)),
    ...tacp.map((s) => injectSessionEnv(s, injectCtx)),
  ];
}
