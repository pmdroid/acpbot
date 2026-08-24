/**
 * CLI: acpbot pair list | approve <code> | status | clear
 *
 * Approves a Telegram pairing code issued by the worker when the bot is unclaimed.
 * Operator identity is stored under `$state_dir/pairing/operator.json` (not config.toml).
 */
import { loadConfig } from "../config";
import type { LoadConfigOptions } from "../config";
import {
  approvePairingCode,
  clearPairedOperator,
  formatPairingCodeDisplay,
  listPendingPairs,
  loadPairedOperator,
  normalizePairingCode,
} from "../core/pairing";
import { ensureAcpbotLayout, resolveConfigWritePath } from "../config-setup";

export function isPairCliCommand(argv: string[] = process.argv): boolean {
  const args = argv.slice(2);
  return args[0] === "pair" || args[0] === "pairing";
}

export function pairCliHelp(): string {
  return `Pairing (operator claim via CLI)
  acpbot pair list              List pending Telegram pairing codes
  acpbot pair approve <code>    Approve a code (stores operator in state dir)
  acpbot pair status            Show paired operator
  acpbot pair clear             Unpair (allows a new approve)

Flow:
  1. Start host + worker with a bot token
  2. User DMs the bot → receives a pairing code
  3. On this machine: acpbot pair approve ABCD-1234
  4. Worker applies claim (no restart required if already running)
  5. Add a workspace: acpbot repo add  (required — /new cannot start a session without one)`;
}

export async function runPairCli(
  argv: string[] = process.argv,
  options: LoadConfigOptions = {},
): Promise<number> {
  const args = argv.slice(2);
  const sub = (args[1] ?? "status").toLowerCase();

  const layout = ensureAcpbotLayout(options);
  const configPath =
    options.configPath ??
    resolveConfigWritePath(options) ??
    layout.configPath;

  let cfg;
  try {
    cfg = loadConfig({
      ...options,
      configPath,
      requireTelegram: false,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const stateDir = cfg.stateDir;

  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(pairCliHelp());
    return 0;
  }

  if (sub === "status") {
    const paired = await loadPairedOperator(stateDir);
    if (paired) {
      console.log(`paired: Telegram user ${paired.userId}`);
      if (paired.chatId !== undefined) console.log(`  chat id: ${paired.chatId}`);
      console.log(`  since: ${new Date(paired.pairedAt).toISOString()}`);
      console.log(`  state: ${stateDir}/pairing/operator.json`);
    } else {
      console.log("paired: no (waiting for pair approve)");
      console.log(`state_dir: ${stateDir}`);
      const pending = await listPendingPairs(stateDir);
      if (pending.length === 0) {
        console.log("No pending codes. DM the bot from Telegram first.");
      } else {
        console.log(`Pending codes: ${pending.length}`);
        for (const p of pending) printPending(p);
      }
    }
    return 0;
  }

  if (sub === "list") {
    const pending = await listPendingPairs(stateDir);
    if (pending.length === 0) {
      console.log("No pending pairing codes.");
      console.log("DM the bot in Telegram (private chat) to get a code.");
      return 0;
    }
    for (const p of pending) printPending(p);
    return 0;
  }

  if (sub === "clear" || sub === "unpair" || sub === "reset") {
    const paired = await loadPairedOperator(stateDir);
    if (!paired) {
      console.log("Not paired — nothing to clear.");
      return 0;
    }
    await clearPairedOperator(stateDir);
    console.log(`Cleared pairing for Telegram user ${paired.userId}.`);
    console.log("Restart is not required; worker will treat the bot as unclaimed.");
    console.log("DM the bot again to get a new code, then: acpbot pair approve <code>");
    return 0;
  }

  if (sub === "approve") {
    const code = args[2];
    if (!code) {
      console.error("Usage: acpbot pair approve <code>");
      return 2;
    }
    try {
      const pending = await approvePairingCode(stateDir, code);
      console.log(
        `Approved ${formatPairingCodeDisplay(normalizePairingCode(code))}`,
      );
      console.log(`  Telegram user id: ${pending.userId}`);
      console.log(`  chat id: ${pending.chatId}`);
      console.log(`  stored: ${stateDir}/pairing/operator.json`);
      console.log(
        "If the worker is running, it will pick this up on the next poll (or within a few seconds).",
      );
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  console.error(`Unknown pair subcommand: ${sub}\n\n${pairCliHelp()}`);
  return 2;
}

function printPending(p: {
  code: string;
  userId: number;
  chatId: number;
  username?: string;
  firstName?: string;
  expiresAt: number;
}): void {
  const who = p.username
    ? `@${p.username}`
    : p.firstName
      ? p.firstName
      : String(p.userId);
  const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
  console.log(
    `  ${p.code}  user=${who} (${p.userId})  chat=${p.chatId}  expires_in=${left}s`,
  );
}
