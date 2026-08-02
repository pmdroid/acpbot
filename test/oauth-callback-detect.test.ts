import { describe, expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import {
  buildHttpCallbackBase,
  detectOAuthCallbackSuggestions,
  isPrivateIPv4,
  listPrivateLanIPv4,
  parseTailscaleStatusJson,
  resolveOAuthSuggestPort,
  stripDnsTrailingDots,
} from "../src/setup/oauth-callback-detect";

const SAMPLE_STATUS = JSON.stringify({
  BackendState: "Running",
  TailscaleIPs: ["100.114.193.89", "fd7a:115c:a1e0::f53a:c159"],
  Self: {
    DNSName: "mac-mini.taile07e4.ts.net.",
    TailscaleIPs: ["100.114.193.89", "fd7a:115c:a1e0::f53a:c159"],
  },
});

describe("oauth-callback-detect", () => {
  test("stripDnsTrailingDots", () => {
    expect(stripDnsTrailingDots("mac-mini.taile07e4.ts.net.")).toBe(
      "mac-mini.taile07e4.ts.net",
    );
    expect(stripDnsTrailingDots("  host.ts.net  ")).toBe("host.ts.net");
  });

  test("parseTailscaleStatusJson", () => {
    const p = parseTailscaleStatusJson(SAMPLE_STATUS);
    expect(p.dnsName).toBe("mac-mini.taile07e4.ts.net");
    expect(p.ipv4).toBe("100.114.193.89");
    expect(parseTailscaleStatusJson("not-json")).toEqual({});
  });

  test("buildHttpCallbackBase", () => {
    expect(buildHttpCallbackBase("mac-mini.taile07e4.ts.net", 8788)).toBe(
      "http://mac-mini.taile07e4.ts.net:8788",
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
          address: "100.114.193.89",
          netmask: "255.255.255.255",
          family: "IPv4",
          mac: "",
          internal: false,
          cidr: "100.114.193.89/32",
        },
      ],
    };
    expect(listPrivateLanIPv4(() => ifaces)).toEqual(["192.168.8.224"]);
  });

  test("detectOAuthCallbackSuggestions prefers MagicDNS then Tailscale IP then LAN", () => {
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
    });
    expect(s.map((x) => x.kind)).toEqual([
      "tailscale-dns",
      "tailscale-ip",
      "lan-ip",
      "lan-ip",
    ]);
    expect(s[0]!.url).toBe("http://mac-mini.taile07e4.ts.net:8788");
    expect(s[1]!.url).toBe("http://100.114.193.89:8788");
    expect(s[2]!.url).toBe("http://192.168.8.224:8788");
    expect(s[3]!.url).toBe("http://10.0.0.42:8788");
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
  });
});
