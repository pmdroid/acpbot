import { describe, expect, test } from "bun:test";
import {
  detectDaemonPlatform,
  launchAgentPlist,
  servicePaths,
  systemdUserUnit,
} from "../src/setup/daemon-install";
import { renderFullConfigToml } from "../src/setup/guided-tui";
import {
  isServiceCliCommand,
  parseServiceCli,
} from "../src/setup/service-cli";

describe("daemon install units", () => {
  test("detectDaemonPlatform knows darwin and linux", () => {
    expect(detectDaemonPlatform("darwin")).toBe("darwin");
    expect(detectDaemonPlatform("linux")).toBe("linux");
    expect(detectDaemonPlatform("win32")).toBe("unsupported");
  });

  test("launchAgentPlist includes KeepAlive and config path", () => {
    const xml = launchAgentPlist({
      label: "app.acpbot.host",
      programArgs: ["/usr/local/bin/acpbot-host", "--config", "/cfg/config.toml"],
      workingDirectory: "/cfg",
      logOut: "/tmp/out.log",
      logErr: "/tmp/err.log",
    });
    expect(xml).toContain("app.acpbot.host");
    expect(xml).toContain("/usr/local/bin/acpbot-host");
    expect(xml).toContain("/cfg/config.toml");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<true/>");
  });

  test("systemdUserUnit has ExecStart and Restart", () => {
    const unit = systemdUserUnit({
      description: "acpbot worker",
      execStart: "/usr/local/bin/acpbot --config /cfg/config.toml",
      workingDirectory: "/cfg",
    });
    expect(unit).toContain("ExecStart=/usr/local/bin/acpbot");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("renderFullConfigToml", () => {
  test("includes speech and oauth sections", () => {
    const toml = renderFullConfigToml({
      botToken: "1:AAAreal-token-here-not-placeholder",
      defaultAgent: "claude",
      logLevel: "info",
      repos: { demo: "/tmp/demo" },
      ttsMode: "agent",
      permissionMode: "ask",
      ttsProvider: "openai",
      sttProvider: "openai",
      openaiApiKey: "sk-test",
      openaiTtsVoice: "nova",
      oauthCallbackBase: "https://x.ts.net",
    });
    expect(toml).toContain("bot_token");
    expect(toml).toContain('default_agent = "claude"');
    expect(toml).toContain("[repos]");
    expect(toml).toContain('demo = "/tmp/demo"');
    expect(toml).toContain("[speech.openai]");
    expect(toml).toContain('api_key = "sk-test"');
    expect(toml).toContain("[oauth]");
    expect(toml).toContain("https://x.ts.net");
    expect(toml).toContain('permission_mode = "ask"');
  });

  test("preserve keeps schedule and agents sections", () => {
    const toml = renderFullConfigToml({
      botToken: "1:AAAreal-token-here-not-placeholder",
      defaultAgent: "grok-build",
      logLevel: "debug",
      repos: {},
      ttsMode: "off",
      permissionMode: "bypass",
      ttsProvider: "off",
      sttProvider: "off",
      preserve: {
        scheduleTickMs: 15000,
        claudeAcpPkg: "@agentclientprotocol/claude-agent-acp@0.64.0",
        mcpEnabled: false,
      },
    });
    expect(toml).toContain("[schedule]");
    expect(toml).toContain("tick_ms = 15000");
    expect(toml).toContain("[agents]");
    expect(toml).toContain("claude_acp_pkg");
    expect(toml).toContain("mcp = false");
    expect(toml).toContain('permission_mode = "bypass"');
  });
});

describe("service CLI", () => {
  test("parseServiceCli recognizes install/start/stop/restart/status", () => {
    expect(parseServiceCli(["x", "acpbot-host", "install"])).toEqual({
      action: "install",
      target: "all",
    });
    expect(parseServiceCli(["x", "acpbot", "start", "--host"])).toEqual({
      action: "start",
      target: "host",
    });
    expect(parseServiceCli(["x", "acpbot", "stop", "--worker"])).toEqual({
      action: "stop",
      target: "worker",
    });
    expect(parseServiceCli(["x", "acpbot", "restart"])?.action).toBe("restart");
    expect(parseServiceCli(["x", "acpbot", "status"])?.action).toBe("status");
    expect(isServiceCliCommand(["x", "acpbot", "uninstall"])).toBe(true);
    expect(isServiceCliCommand(["x", "acpbot", "setup"])).toBe(false);
  });

  test("servicePaths points at standard unit locations", () => {
    const p = servicePaths({ env: { HOME: "/home/u" } });
    expect(p.hostPlist).toContain("LaunchAgents");
    expect(p.hostPlist).toContain("app.acpbot.host");
    expect(p.workerPlist).toContain("app.acpbot.worker");
    expect(p.hostUnit).toContain("acpbot-host.service");
    expect(p.workerUnit).toContain("acpbot.service");
  });
});
