/**
 * CLI: acpbot pair list | approve <code> | status
 *
 * Approves a Telegram pairing code issued by the worker when the bot is unclaimed.
 */
import { loadConfig } from "../config";
import {
  approvePairingCode,
  formatPairingCodeDisplay,
  listPendingPairs,
  normalizePairingCode,
} from "../core/pairing";
import {
  ensureAcpbotLayout,
  patchConfigOperatorUserId,
  resolveConfigWritePath,
} from "../config-setup";
import type { LoadConfigOptions } from "../config";

export function isPairCliCommand(argv: string[] = process.argv): boolean {
  const args = argv.slice(2);
  return args[0] === "pair" || args[0] === "pairing";
}

export function pairCliHelp(): string {
  return `Pairing (operator claim via CLI)
  acpbot pair list              List pending Telegram pairing codes
  acpbot pair approve <code>    Approve a code (sets operator_user_id in config)
  acpbot pair status            Show current operator from config

Flow:
  1. Leave operator_user_id = 0 (or unset) in config.toml
  2. User DMs the bot → receives a pairing code
  3. On this machine: acpbot pair approve ABCD-1234
  4. Worker applies claim (no restart required if already running)`;
}

export async function runPairCli(
  argv: string[] = process.argv,
  options: LoadConfigOptions = {},
): Promise<number> {
  const args = argv.slice(2);
  // pair | pairing
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
    console.error(
      err instanceof Error ? err.message : String(err),
    );
    return 1;
  }
  const stateDir = cfg.stateDir;

  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(pairCliHelp());
    return 0;
  }

  if (sub === "status") {
    if (cfg.operatorUserId > 0) {
      console.log(`operator_user_id = ${cfg.operatorUserId} (claimed)`);
      console.log(`config: ${cfg.configPath ?? configPath}`);
      console.log(`state_dir: ${stateDir}`);
    } else {
      console.log("operator_user_id = 0 (unclaimed — waiting for pair approve)");
      console.log(`config: ${cfg.configPath ?? configPath}`);
      console.log(`state_dir: ${stateDir}`);
      const pending = await listPendingPairs(stateDir);
      if (pending.length === 0) {
        console.log("No pending pairing codes. DM the bot from Telegram first.");
      } else {
        console.log(`Pending codes: ${pending.length}`);
        for (const p of pending) {
          printPending(p);
        }
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

  if (sub === "approve") {
    const code = args[2];
    if (!code) {
      console.error("Usage: acpbot pair approve <code>");
      return 2;
    }
    if (cfg.operatorUserId > 0) {
      console.error(
        `Already claimed as operator_user_id = ${cfg.operatorUserId}.\n` +
          `Edit config.toml to set operator_user_id = 0 if you want to re-pair.`,
      );
      return 1;
    }
    try {
      const pending = await approvePairingCode(stateDir, code);
      patchConfigOperatorUserId(configPath, pending.userId);
      console.log(`Approved ${formatPairingCodeDisplay(normalizePairingCode(code))}`);
      console.log(`  Telegram user id: ${pending.userId}`);
      console.log(`  chat id: ${pending.chatId}`);
      console.log(`  wrote operator_user_id = ${pending.userId} → ${configPath}`);
      console.log(
        "If the worker is running, it will pick this up on the next update (or within a few seconds).",
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
