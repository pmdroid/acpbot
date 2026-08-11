#!/usr/bin/env bun
/**
 * Unified acpbot CLI — one binary for host, worker, setup, and services.
 *
 *   acpbot                 → help
 *   acpbot host            → ACP host
 *   acpbot worker          → Telegram worker
 *   acpbot setup | repo | pair | skills | mcp-proxy | install | …
 *
 * Legacy: if the executable is named `acpbot-host`, defaults to host mode
 * (after service/setup subcommands).
 */
import { acpbotCliHelp } from "./cli-help";
import { isAcpbotHostInvocation } from "./cli-router";
import { runHostMain } from "./host-run";
import { runWorkerMain } from "./worker-run";
import {
  isSetupCliCommand,
  runSetupCommand,
} from "./config-setup";
import {
  isServiceCliCommand,
  runServiceCli,
} from "./setup/service-cli";
import {
  isPairCliCommand,
  runPairCli,
} from "./setup/pair-cli";
import {
  isRepoCliCommand,
  runRepoCli,
} from "./setup/repo-cli";
import {
  isSkillsCliCommand,
  runSkillsCli,
} from "./setup/skills-cli";
import { runMcpProxyMain } from "./mcp/proxy";
import { isChatCliCommand, runChatCli } from "./chat/cli";

function printHelp(): void {
  console.log(acpbotCliHelp());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = (args[0] ?? "").toLowerCase();
  const asHostBin = isAcpbotHostInvocation();

  // Service control: install | start | stop | restart | status | uninstall
  // Works for both `acpbot install` and legacy `acpbot-host install`.
  if (isServiceCliCommand(process.argv)) {
    const code = await runServiceCli(process.argv);
    process.exitCode = code;
    return;
  }

  // Pairing (no host required)
  if (isPairCliCommand(process.argv)) {
    const code = await runPairCli(process.argv);
    process.exitCode = code;
    return;
  }

  // Workspace repos
  if (isRepoCliCommand(process.argv)) {
    const code = await runRepoCli(process.argv);
    process.exitCode = code;
    return;
  }

  // Bundled skills install (global agent dirs)
  if (isSkillsCliCommand(process.argv)) {
    const code = await runSkillsCli(process.argv);
    process.exitCode = code;
    return;
  }

  // Multi-session chat hub (requires host; no Telegram worker)
  if (isChatCliCommand(process.argv)) {
    const code = await runChatCli(process.argv);
    process.exitCode = code;
    return;
  }

  // Explicit help
  if (
    !cmd ||
    cmd === "help" ||
    cmd === "-h" ||
    cmd === "--help" ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    // Legacy acpbot-host with no args → run host (not help)
    if (asHostBin && !cmd) {
      await runHostMain();
      return;
    }
    printHelp();
    return;
  }

  // Guided setup
  if (isSetupCliCommand(process.argv)) {
    await runSetupCommand();
    return;
  }

  // Process roles
  if (cmd === "host" || cmd === "acp-host" || cmd === "acphost") {
    // Drop the role token so --config still parses from remaining argv
    process.argv = [process.argv[0]!, process.argv[1]!, ...args.slice(1)];
    await runHostMain();
    return;
  }

  if (cmd === "worker") {
    process.argv = [process.argv[0]!, process.argv[1]!, ...args.slice(1)];
    await runWorkerMain();
    return;
  }

  // Stdio MCP proxy for a remote OAuth gateway (spawned per agent session)
  if (cmd === "mcp-proxy" || cmd === "mcp_proxy" || cmd === "mcpproxy") {
    await runMcpProxyMain();
    return;
  }

  // Built-in acpbot tools MCP (speak / telegram / schedules) over stdio
  if (cmd === "mcp-server" || cmd === "mcp_server") {
    await import("./mcp/server");
    return;
  }

  // Legacy binary name: any leftover args go to host (usually just --config)
  if (asHostBin) {
    await runHostMain();
    return;
  }

  console.error(`Unknown command: ${args[0]}`);
  console.error("");
  printHelp();
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
