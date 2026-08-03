#!/usr/bin/env bun
/**
 * Thin entry for `bun run acp-host` and legacy dual-binary builds.
 *
 * Prefer the unified CLI: `acpbot host`.
 * If this file is still compiled as `acpbot-host`, basename detection in
 * `src/main.ts` is not used — we just run the host.
 */
import {
  isServiceCliCommand,
  runServiceCli,
  serviceCliHelp,
} from "../setup/service-cli";
import { runHostMain } from "../host-run";

async function main(): Promise<void> {
  if (isServiceCliCommand(process.argv)) {
    const code = await runServiceCli(process.argv);
    process.exitCode = code;
    return;
  }

  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(`acpbot host — long-lived agent owner

  acpbot host                 Run host (preferred)
  acpbot-host                 Legacy binary name (same as acpbot host)
  acpbot install|start|…      Background services

${serviceCliHelp()}`);
    return;
  }

  await runHostMain();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
