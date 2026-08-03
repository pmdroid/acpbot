import { pairCliHelp } from "./setup/pair-cli";
import { repoCliHelp } from "./setup/repo-cli";
import { serviceCliHelp } from "./setup/service-cli";

/** Top-level help for the unified `acpbot` binary. */
export function acpbotCliHelp(): string {
  return `acpbot — Telegram control surface for ACP coding agents

Usage:
  acpbot <command> [options]

Processes (foreground):
  acpbot host                 ACP host — agents, schedules, OAuth callback
  acpbot worker               Telegram worker (requires host)

Setup & config:
  acpbot setup                Guided setup TUI
  acpbot repo                 Manage workspace repos (folder browser)
  acpbot pair …               Operator pairing (see below)

Services (background LaunchAgent / systemd):
  acpbot install|start|stop|restart|status|uninstall
  acpbot start --host | --worker

  acpbot help                 Show this help

Typical local run:
  acpbot host                 # terminal 1
  acpbot worker               # terminal 2
  # or: acpbot install && acpbot start

${repoCliHelp()}

${pairCliHelp()}

${serviceCliHelp()}`;
}
