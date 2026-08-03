import { describe, expect, test } from "bun:test";
import { acpbotCliHelp } from "../src/cli-help";
import { isAcpbotHostInvocation } from "../src/cli-router";

describe("unified CLI", () => {
  test("help mentions host and worker", () => {
    const h = acpbotCliHelp();
    expect(h).toContain("acpbot host");
    expect(h).toContain("acpbot worker");
    expect(h).toContain("acpbot setup");
    expect(h).toContain("acpbot repo");
    expect(h).toContain("acpbot skills install");
  });

  test("isAcpbotHostInvocation by basename", () => {
    expect(
      isAcpbotHostInvocation(["/usr/bin/bun", "/usr/local/bin/acpbot-host"]),
    ).toBe(true);
    expect(
      isAcpbotHostInvocation([
        "/usr/bin/bun",
        "/tmp/acpbot-host-v0.1.0-darwin-arm64",
      ]),
    ).toBe(true);
    expect(
      isAcpbotHostInvocation(["/usr/bin/bun", "/usr/local/bin/acpbot"]),
    ).toBe(false);
    expect(
      isAcpbotHostInvocation(["/usr/bin/bun", "/Volumes/x/src/main.ts"]),
    ).toBe(false);
  });
});
