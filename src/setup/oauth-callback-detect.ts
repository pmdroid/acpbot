/**
 * Suggest OAuth callback_base hosts for guided setup.
 *
 * Always tries to offer, in order:
 *   1. Tailscale MagicDNS as **https://host:8788** (TLS via ~/.local/share/tailscale-certs/)
 *   2. Tailscale IPv4 (http://100.x:8788)
 *   3. Private LAN IPv4 (http://10/192.168…:8788)
 *
 * Listener always defaults to port 8788 — MagicDNS just flips the scheme to
 * HTTPS and loads Tailscale certs; it does not move to :443.
 *
 * Never invents a public internet hostname — custom URLs stay manual.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** Default OAuth listen / callback port (HTTP and HTTPS). */
export const DEFAULT_OAUTH_LISTEN_PORT = 8788;

export type OAuthCallbackSuggestionKind =
  | "tailscale-dns"
  | "tailscale-ip"
  | "lan-ip";

export type OAuthCallbackSuggestion = {
  kind: OAuthCallbackSuggestionKind;
  /** e.g. your-node.ts.net or 100.x.y.z */
  host: string;
  /** Full callback base URL (no trailing slash). */
  url: string;
  label: string;
  hint?: string;
  /** When set, setup should write [oauth] tls_cert / tls_key. */
  tlsCertPath?: string;
  tlsKeyPath?: string;
  /** True when MagicDNS HTTPS is suggested but cert files are missing. */
  needsTailscaleCert?: boolean;
};

export type DetectOAuthCallbackOptions = {
  /** Listen/callback port for all suggestions (default 8788). */
  port?: number;
  /**
   * Return raw `tailscale status --json` stdout, or null if unavailable.
   * Injected in tests; production uses the local CLI.
   */
  readTailscaleStatusJson?: () => string | null;
  /** Injected networkInterfaces() for tests. */
  getNetworkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[] | undefined>;
  /** HOME / XDG for cert dir (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override cert lookup (tests). */
  findCertPair?: (dnsName: string) => TailscaleCertPair | null;
};

export type TailscaleCertPair = {
  certPath: string;
  keyPath: string;
};

/** Strip trailing dots from MagicDNS names (`your-node.foo.ts.net.`). */
export function stripDnsTrailingDots(name: string): string {
  return name.trim().replace(/\.+$/, "");
}

/**
 * Default directory for `tailscale cert` outputs (Linux + macOS).
 * `~/.local/share/tailscale-certs/<dns>.crt` + `.key`
 */
export function defaultTailscaleCertDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  if (xdg) return join(xdg, "tailscale-certs");
  return join(home, ".local", "share", "tailscale-certs");
}

/** Paths for a MagicDNS name under the cert dir. */
export function tailscaleCertPaths(
  dnsName: string,
  env: NodeJS.ProcessEnv = process.env,
): TailscaleCertPair {
  const dir = defaultTailscaleCertDir(env);
  const host = stripDnsTrailingDots(dnsName);
  return {
    certPath: join(dir, `${host}.crt`),
    keyPath: join(dir, `${host}.key`),
  };
}

/** Return cert pair if both files exist. */
export function findTailscaleCertPair(
  dnsName: string,
  env: NodeJS.ProcessEnv = process.env,
): TailscaleCertPair | null {
  const pair = tailscaleCertPaths(dnsName, env);
  if (existsSync(pair.certPath) && existsSync(pair.keyPath)) return pair;
  return null;
}

/**
 * Operator instructions for issuing certs (macOS + Linux).
 * `tailscale cert` writes `<name>.crt` and `<name>.key` into the cwd.
 *
 * Expected layout (same on both platforms):
 *   Certificate  ~/.local/share/tailscale-certs/<dns>.crt
 *   Private key  ~/.local/share/tailscale-certs/<dns>.key
 * (or $XDG_DATA_HOME/tailscale-certs/ when XDG_DATA_HOME is set)
 */
export function tailscaleCertSetupHelp(
  dnsName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const host = stripDnsTrailingDots(dnsName);
  const dir = defaultTailscaleCertDir(env);
  const cert = `${dir}/${host}.crt`;
  const key = `${dir}/${host}.key`;
  return [
    `Tailscale HTTPS for OAuth (MagicDNS: ${host})`,
    "",
    "1. Install Tailscale CLI and log in (HTTPS / MagicDNS enabled for the node).",
    "2. Issue a cert (macOS and Linux — same commands):",
    "",
    `   mkdir -p ${dir}`,
    `   cd ${dir}`,
    `   tailscale cert ${host}`,
    "",
    "   Files created (same layout on macOS and Linux):",
    "",
    "   ┌─────────────┬──────────────────────────────────────────────────────────────┐",
    "   │ File        │ Path                                                         │",
    "   ├─────────────┼──────────────────────────────────────────────────────────────┤",
    `   │ Certificate │ ${cert}`,
    `   │ Private key │ ${key}`,
    "   └─────────────┴──────────────────────────────────────────────────────────────┘",
    "",
    "3. acpbot auto-detects those files (no need to set tls_cert/tls_key by hand).",
    "   Suggested callback_base (HTTPS on the same port as HTTP):",
    `     https://${host}:${DEFAULT_OAUTH_LISTEN_PORT}`,
    `   Listener binds 0.0.0.0:${DEFAULT_OAUTH_LISTEN_PORT} with TLS.`,
    "",
    "Re-run: acpbot setup  (or restart the host after certs appear).",
  ].join("\n");
}

/**
 * Build callback base URL.
 * Always includes an explicit port (default 8788) for both http and https,
 * except https on 443 omits the port (standard URL form).
 */
export function buildCallbackBase(
  host: string,
  options: { scheme?: "http" | "https"; port?: number } = {},
): string {
  const scheme = options.scheme ?? "http";
  const raw = host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const hostOnly = raw.includes("/") ? raw.slice(0, raw.indexOf("/")) : raw;
  const withoutPort = stripHostPort(hostOnly);
  const isV6 =
    withoutPort.includes(":") &&
    !withoutPort.startsWith("[") &&
    withoutPort.split(":").length > 2;
  const authority = isV6 ? `[${withoutPort}]` : withoutPort;

  const p =
    options.port !== undefined &&
    Number.isFinite(options.port) &&
    options.port > 0 &&
    options.port < 65536
      ? Math.floor(options.port)
      : DEFAULT_OAUTH_LISTEN_PORT;

  if (scheme === "https") {
    if (p === 443) return `https://${authority}`;
    return `https://${authority}:${p}`;
  }
  return `http://${authority}:${p}`;
}

/** @deprecated use buildCallbackBase — kept for tests */
export function buildHttpCallbackBase(host: string, port: number): string {
  return buildCallbackBase(host, { scheme: "http", port });
}

function stripHostPort(host: string): string {
  const h = host.trim();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end > 0) return h.slice(1, end);
  }
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(h);
  if (m) return m[1]!;
  if (/^[a-zA-Z0-9._-]+:\d+$/.test(h)) {
    return h.slice(0, h.lastIndexOf(":"));
  }
  const colon = h.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(h.slice(colon + 1)) && !h.includes("::")) {
    const left = h.slice(0, colon);
    if (!left.includes(":")) return left;
  }
  return h;
}

/** Parse Self.DNSName + TailscaleIPs from `tailscale status --json`. */
export function parseTailscaleStatusJson(json: string): {
  dnsName?: string;
  ipv4?: string;
} {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object") return {};
  const root = data as Record<string, unknown>;
  const self =
    root.Self && typeof root.Self === "object"
      ? (root.Self as Record<string, unknown>)
      : undefined;

  let dnsName: string | undefined;
  const rawDns = self?.DNSName ?? self?.DnsName;
  if (typeof rawDns === "string" && rawDns.trim()) {
    dnsName = stripDnsTrailingDots(rawDns);
  }

  const ipLists: unknown[] = [];
  if (Array.isArray(self?.TailscaleIPs)) ipLists.push(...self.TailscaleIPs);
  if (Array.isArray(root.TailscaleIPs)) ipLists.push(...root.TailscaleIPs);

  let ipv4: string | undefined;
  for (const ip of ipLists) {
    if (typeof ip !== "string") continue;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
      ipv4 = ip;
      break;
    }
  }

  return { dnsName, ipv4 };
}

function defaultReadTailscaleStatusJson(): string | null {
  try {
    const r = spawnSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      timeout: 4000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) return null;
    const out = (r.stdout ?? "").trim();
    return out || null;
  } catch {
    return null;
  }
}

/** RFC1918 / CGNAT private IPv4 (exclude loopback & link-local). */
export function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function listPrivateLanIPv4(
  getIfaces: () => NodeJS.Dict<NetworkInterfaceInfo[] | undefined> = networkInterfaces,
): string[] {
  const out: string[] = [];
  const ifaces = getIfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const ent of entries) {
      if (ent.family !== "IPv4" && ent.family !== 4) continue;
      if (ent.internal) continue;
      if (!isPrivateIPv4(ent.address)) continue;
      if (ent.address.startsWith("100.")) continue;
      if (!out.includes(ent.address)) out.push(ent.address);
    }
  }
  return out;
}

/**
 * Detect suggested callback bases for setup UI.
 * MagicDNS → **https://host:8788** (TLS + cert status); IP options stay http://…:8788.
 */
export function detectOAuthCallbackSuggestions(
  options: DetectOAuthCallbackOptions = {},
): OAuthCallbackSuggestion[] {
  const port = options.port ?? DEFAULT_OAUTH_LISTEN_PORT;
  const env = options.env ?? process.env;
  const readJson =
    options.readTailscaleStatusJson ?? defaultReadTailscaleStatusJson;
  const getIfaces = options.getNetworkInterfaces ?? networkInterfaces;
  const findCert = options.findCertPair ?? ((d: string) => findTailscaleCertPair(d, env));

  const suggestions: OAuthCallbackSuggestion[] = [];
  const seenUrls = new Set<string>();

  const push = (s: OAuthCallbackSuggestion) => {
    if (seenUrls.has(s.url)) return;
    seenUrls.add(s.url);
    suggestions.push(s);
  };

  const raw = readJson();
  if (raw) {
    const { dnsName, ipv4 } = parseTailscaleStatusJson(raw);
    if (dnsName) {
      const certs = findCert(dnsName);
      const url = buildCallbackBase(dnsName, { scheme: "https", port });
      push({
        kind: "tailscale-dns",
        host: dnsName,
        url,
        label: certs
          ? `Tailscale HTTPS (${dnsName})`
          : `Tailscale HTTPS (${dnsName}) — cert missing`,
        hint: certs
          ? `TLS on :${port} · ${certs.certPath}`
          : `Cert missing — mkdir -p ~/.local/share/tailscale-certs && cd $_ && tailscale cert ${dnsName}`,
        ...(certs
          ? { tlsCertPath: certs.certPath, tlsKeyPath: certs.keyPath }
          : { needsTailscaleCert: true }),
      });
    }
    if (ipv4) {
      const url = buildCallbackBase(ipv4, {
        scheme: "http",
        port,
      });
      push({
        kind: "tailscale-ip",
        host: ipv4,
        url,
        label: `Tailscale IP (${ipv4})`,
        hint: "http 100.x — works on the tailnet without MagicDNS certs",
      });
    }
  }

  const lan = listPrivateLanIPv4(getIfaces);
  const maxLan = 4;
  for (const ip of lan.slice(0, maxLan)) {
    const url = buildCallbackBase(ip, { scheme: "http", port });
    push({
      kind: "lan-ip",
      host: ip,
      url,
      label: `LAN IP (${ip})`,
      hint: "Same local network only — not via cellular / off-LAN",
    });
  }

  return suggestions;
}

/** Resolve listen port for suggestions / config (default 8788 for both schemes). */
export function resolveOAuthSuggestPort(input: {
  oauthListenPort?: number;
  oauthCallbackBase?: string;
}): number {
  if (
    input.oauthListenPort !== undefined &&
    Number.isFinite(input.oauthListenPort) &&
    input.oauthListenPort > 0 &&
    input.oauthListenPort < 65536
  ) {
    return Math.floor(input.oauthListenPort);
  }
  const base = input.oauthCallbackBase?.trim();
  if (base) {
    try {
      const u = new URL(base.includes("://") ? base : `http://${base}`);
      if (u.port) {
        const n = Number(u.port);
        if (Number.isFinite(n) && n > 0) return n;
      }
      // Bare https://host with no port → still 8788 (not 443)
    } catch {
      /* ignore */
    }
  }
  return DEFAULT_OAUTH_LISTEN_PORT;
}
