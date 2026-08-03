import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import {
  buildCallbackBase,
  buildHttpCallbackBase,
  defaultTailscaleCertDir,
  detectOAuthCallbackSuggestions,
  findTailscaleCertPair,
  isPrivateIPv4,
  listPrivateLanIPv4,
  parseTailscaleStatusJson,
  resolveOAuthSuggestPort,
  stripDnsTrailingDots,
  tailscaleCertPaths,
  tailscaleCertSetupHelp,
} from "../src/setup/oauth-callback-detect";

const SAMPLE_STATUS = JSON.stringify({
  BackendState: "Running",
  TailscaleIPs: ["100.64.1.2", "fd7a:115c:a1e0::1"],
  Self: {
    DNSName: "your-node.ts.net.",
    TailscaleIPs: ["100.64.1.2", "fd7a:115c:a1e0::1"],
  },
});

describe("oauth-callback-detect", () => {
  test("stripDnsTrailingDots", () => {
    expect(stripDnsTrailingDots("your-node.ts.net.")).toBe(
      "your-node.ts.net",
    );
    expect(stripDnsTrailingDots("  host.ts.net  ")).toBe("host.ts.net");
  });

  test("parseTailscaleStatusJson", () => {
    const p = parseTailscaleStatusJson(SAMPLE_STATUS);
    expect(p.dnsName).toBe("your-node.ts.net");
    expect(p.ipv4).toBe("100.64.1.2");
    expect(parseTailscaleStatusJson("not-json")).toEqual({});
  });

  test("buildCallbackBase https defaults to :8788 (not 443)", () => {
    expect(
      buildCallbackBase("your-node.ts.net", { scheme: "https" }),
    ).toBe("https://your-node.ts.net:8788");
    expect(
      buildCallbackBase("your-node.ts.net", {
        scheme: "https",
        port: 8788,
      }),
    ).toBe("https://your-node.ts.net:8788");
    expect(
      buildCallbackBase("your-node.ts.net", {
        scheme: "https",
        port: 443,
      }),
    ).toBe("https://your-node.ts.net");
  });

  test("buildHttpCallbackBase", () => {
    expect(buildHttpCallbackBase("your-node.ts.net", 8788)).toBe(
      "http://your-node.ts.net:8788",
    );
    expect(buildHttpCallbackBase("100.1.2.3", 8788)).toBe(
      "http://100.1.2.3:8788",
    );
    expect(buildHttpCallbackBase("fd7a:115c:a1e0::1", 8788)).toBe(
      "http://[fd7a:115c:a1e0::1]:8788",
    );
    expect(buildHttpCallbackBase("http://host.example:9999", 8788)).toBe(
      "http://host.example:8788",
    );
  });

  test("defaultTailscaleCertDir respects XDG and HOME", () => {
    expect(
      defaultTailscaleCertDir({ HOME: "/home/u", XDG_DATA_HOME: undefined }),
    ).toBe("/home/u/.local/share/tailscale-certs");
    expect(
      defaultTailscaleCertDir({
        HOME: "/home/u",
        XDG_DATA_HOME: "/home/u/.xdg-data",
      }),
    ).toBe("/home/u/.xdg-data/tailscale-certs");
  });

  test("tailscaleCertPaths and findTailscaleCertPair", () => {
    const root = join(
      tmpdir(),
      `acpbot-ts-certs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const env = { HOME: root, XDG_DATA_HOME: undefined as string | undefined };
    const dns = "your-node.ts.net";
    const paths = tailscaleCertPaths(dns, env);
    expect(paths.certPath).toBe(
      join(root, ".local", "share", "tailscale-certs", `${dns}.crt`),
    );
    expect(paths.keyPath).toBe(
      join(root, ".local", "share", "tailscale-certs", `${dns}.key`),
    );
    expect(findTailscaleCertPair(dns, env)).toBeNull();

    mkdirSync(join(root, ".local", "share", "tailscale-certs"), {
      recursive: true,
    });
    writeFileSync(paths.certPath, "CERT");
    writeFileSync(paths.keyPath, "KEY");
    expect(findTailscaleCertPair(dns, env)).toEqual(paths);
    rmSync(root, { recursive: true, force: true });
  });

  test("tailscaleCertSetupHelp lists cert and key paths", () => {
    const help = tailscaleCertSetupHelp("your-node.ts.net", {
      HOME: "/Users/me",
    });
    expect(help).toContain("tailscale cert your-node.ts.net");
    expect(help).toContain(
      "/Users/me/.local/share/tailscale-certs/your-node.ts.net.crt",
    );
    expect(help).toContain(
      "/Users/me/.local/share/tailscale-certs/your-node.ts.net.key",
    );
    expect(help).toContain("Certificate");
    expect(help).toContain("Private key");
    expect(help).toContain("https://your-node.ts.net:8788");
  });

  test("isPrivateIPv4", () => {
    expect(isPrivateIPv4("192.168.1.1")).toBe(true);
    expect(isPrivateIPv4("10.0.0.5")).toBe(true);
    expect(isPrivateIPv4("172.16.0.1")).toBe(true);
    expect(isPrivateIPv4("100.64.0.1")).toBe(true);
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateIPv4("127.0.0.1")).toBe(false);
  });

  test("listPrivateLanIPv4 skips loopback and 100.x", () => {
    const ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      lo0: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      en0: [
        {
          address: "192.168.8.224",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.8.224/24",
        },
      ],
      utun4: [
        {
          address: "100.64.1.2",
          netmask: "255.255.255.255",
          family: "IPv4",
          mac: "",
          internal: false,
          cidr: "100.64.1.2/32",
        },
      ],
    };
    expect(listPrivateLanIPv4(() => ifaces)).toEqual(["192.168.8.224"]);
  });

  test("detectOAuthCallbackSuggestions uses https MagicDNS then Tailscale IP then LAN", () => {
    const ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      en0: [
        {
          address: "192.168.8.224",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa",
          internal: false,
          cidr: "192.168.8.224/24",
        },
      ],
      en1: [
        {
          address: "10.0.0.42",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "bb",
          internal: false,
          cidr: "10.0.0.42/24",
        },
      ],
    };
    const s = detectOAuthCallbackSuggestions({
      port: 8788,
      readTailscaleStatusJson: () => SAMPLE_STATUS,
      getNetworkInterfaces: () => ifaces,
      findCertPair: () => null,
    });
    expect(s.map((x) => x.kind)).toEqual([
      "tailscale-dns",
      "tailscale-ip",
      "lan-ip",
      "lan-ip",
    ]);
    expect(s[0]!.url).toBe("https://your-node.ts.net:8788");
    expect(s[0]!.needsTailscaleCert).toBe(true);
    expect(s[0]!.label).toContain("cert missing");
    expect(s[1]!.url).toBe("http://100.64.1.2:8788");
    expect(s[2]!.url).toBe("http://192.168.8.224:8788");
    expect(s[3]!.url).toBe("http://10.0.0.42:8788");
  });

  test("detectOAuthCallbackSuggestions attaches cert paths when present", () => {
    const s = detectOAuthCallbackSuggestions({
      port: 8788,
      readTailscaleStatusJson: () => SAMPLE_STATUS,
      getNetworkInterfaces: () => ({}),
      findCertPair: (dns) => ({
        certPath: `/certs/${dns}.crt`,
        keyPath: `/certs/${dns}.key`,
      }),
    });
    expect(s[0]!.url).toBe("https://your-node.ts.net:8788");
    expect(s[0]!.needsTailscaleCert).toBeUndefined();
    expect(s[0]!.tlsCertPath).toBe(
      "/certs/your-node.ts.net.crt",
    );
    expect(s[0]!.tlsKeyPath).toBe("/certs/your-node.ts.net.key");
    expect(s[0]!.label).not.toContain("cert missing");
  });

  test("detectOAuthCallbackSuggestions shows LAN when no Tailscale", () => {
    const ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      en0: [
        {
          address: "10.0.0.42",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa",
          internal: false,
          cidr: "10.0.0.42/24",
        },
      ],
    };
    const s = detectOAuthCallbackSuggestions({
      port: 9000,
      readTailscaleStatusJson: () => null,
      getNetworkInterfaces: () => ifaces,
    });
    expect(s).toHaveLength(1);
    expect(s[0]!.kind).toBe("lan-ip");
    expect(s[0]!.url).toBe("http://10.0.0.42:9000");
  });

  test("resolveOAuthSuggestPort", () => {
    expect(resolveOAuthSuggestPort({})).toBe(8788);
    expect(resolveOAuthSuggestPort({ oauthListenPort: 9001 })).toBe(9001);
    expect(
      resolveOAuthSuggestPort({
        oauthCallbackBase: "http://h.example:4444",
      }),
    ).toBe(4444);
    expect(
      resolveOAuthSuggestPort({
        oauthCallbackBase: "https://your-node.ts.net",
      }),
    ).toBe(8788);
    expect(
      resolveOAuthSuggestPort({
        oauthCallbackBase: "https://your-node.ts.net:8788",
      }),
    ).toBe(8788);
  });
});
