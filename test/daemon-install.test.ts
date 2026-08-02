import { describe, expect, test } from "bun:test";
import {
  detectDaemonPlatform,
  launchAgentPlist,
  systemdUserUnit,
} from "../src/setup/daemon-install";
import { renderFullConfigToml } from "../src/setup/guided-tui";

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
      operatorUserId: 0,
      defaultAgent: "claude",
      logLevel: "info",
      repos: { demo: "/tmp/demo" },
      ttsMode: "agent",
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
  });
});
