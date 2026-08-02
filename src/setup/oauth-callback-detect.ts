/**
 * Suggest OAuth callback_base hosts for guided setup.
 *
 * Always tries to offer, in order:
 *   1. Tailscale MagicDNS (Self.DNSName from `tailscale status --json`)
 *   2. Tailscale IPv4 (100.x)
 *   3. Private LAN IPv4 (10.x / 172.16–31.x / 192.168.x) — always, when present
 *
 * Never invents a public internet hostname — custom URLs stay manual.
 */
import { spawnSync } from "node:child_process";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export const DEFAULT_OAUTH_LISTEN_PORT = 8788;

export type OAuthCallbackSuggestionKind =
  | "tailscale-dns"
  | "tailscale-ip"
  | "lan-ip";

export type OAuthCallbackSuggestion = {
  kind: OAuthCallbackSuggestionKind;
  /** e.g. mac-mini.taile07e4.ts.net or 100.x.y.z */
  host: string;
  /** Full callback base URL (no trailing slash, includes port when non-default). */
  url: string;
  label: string;
  hint?: string;
};

export type DetectOAuthCallbackOptions = {
  /** Port embedded in suggested URLs (default 8788). */
  port?: number;
  /**
   * Return raw `tailscale status --json` stdout, or null if unavailable.
   * Injected in tests; production uses the local CLI.
   */
  readTailscaleStatusJson?: () => string | null;
  /** Injected networkInterfaces() for tests. */
  getNetworkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[] | undefined>;
};

/** Strip trailing dots from MagicDNS names (`mac-mini.foo.ts.net.`). */
export function stripDnsTrailingDots(name: string): string {
  return name.trim().replace(/\.+$/, "");
}

/**
 * Build `http://host:port` for OAuth callback_base.
 * IPv6 hosts are bracketed. Port is always included so the redirect
 * matches acp-host's listener (default 8788, not 80).
 */
export function buildHttpCallbackBase(host: string, port: number): string {
  const raw = host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  // Strip accidental path/port if someone passed a full URL host part
  const hostOnly = raw.includes("/") ? raw.slice(0, raw.indexOf("/")) : raw;
  const withoutPort = stripHostPort(hostOnly);
  const isV6 =
    withoutPort.includes(":") &&
    !withoutPort.startsWith("[") &&
    withoutPort.split(":").length > 2;
  const authority = isV6 ? `[${withoutPort}]` : withoutPort;
  const p =
    Number.isFinite(port) && port > 0 && port < 65536
      ? Math.floor(port)
      : DEFAULT_OAUTH_LISTEN_PORT;
  return `http://${authority}:${p}`;
}

function stripHostPort(host: string): string {
  const h = host.trim();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end > 0) return h.slice(1, end);
  }
  // hostname:port or IPv4:port — not bare IPv6
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(h);
  if (m) return m[1]!;
  if (/^[a-zA-Z0-9._-]+:\d+$/.test(h)) {
    return h.slice(0, h.lastIndexOf(":"));
  }
  // typo guard: hostname:port
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
    // Prefer CGNAT 100.x / classic Tailscale IPv4
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
  // Tailscale CGNAT
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
      // Skip Tailscale CGNAT here — listed separately when Tailscale is up
      if (ent.address.startsWith("100.")) continue;
      if (!out.includes(ent.address)) out.push(ent.address);
    }
  }
  return out;
}

/**
 * Detect suggested callback bases for setup UI.
 * Order: MagicDNS → Tailscale IPv4 → private LAN IPv4 (10/172.16–31/192.168).
 * LAN addresses are always offered when present — not only when Tailscale is down.
 */
export function detectOAuthCallbackSuggestions(
  options: DetectOAuthCallbackOptions = {},
): OAuthCallbackSuggestion[] {
  const port = options.port ?? DEFAULT_OAUTH_LISTEN_PORT;
  const readJson =
    options.readTailscaleStatusJson ?? defaultReadTailscaleStatusJson;
  const getIfaces = options.getNetworkInterfaces ?? networkInterfaces;

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
      const url = buildHttpCallbackBase(dnsName, port);
      push({
        kind: "tailscale-dns",
        host: dnsName,
        url,
        label: `Tailscale DNS (${dnsName})`,
        hint: "MagicDNS name — best when phone is on the same tailnet",
      });
    }
    if (ipv4) {
      const url = buildHttpCallbackBase(ipv4, port);
      push({
        kind: "tailscale-ip",
        host: ipv4,
        url,
        label: `Tailscale IP (${ipv4})`,
        hint: "100.x address — works on the tailnet without MagicDNS",
      });
    }
  }

  // Always list private LAN IPv4 (same Wi‑Fi / Ethernet; not via cellular)
  const lan = listPrivateLanIPv4(getIfaces);
  // Cap so multi-homed machines don't flood the select list
  const maxLan = 4;
  for (const ip of lan.slice(0, maxLan)) {
    const url = buildHttpCallbackBase(ip, port);
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

/** Resolve listen port for suggestions: explicit config, URL port, else 8788. */
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
    } catch {
      /* ignore */
    }
  }
  return DEFAULT_OAUTH_LISTEN_PORT;
}
