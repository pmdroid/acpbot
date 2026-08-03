/**
 * How to re-invoke the acpbot CLI as a child (MCP stdio servers, proxies).
 * Works for both compiled binary and `bun run src/main.ts …`.
 */
import { basename } from "node:path";

export type AcpbotSpawn = {
  command: string;
  /** Prefix before the subcommand, e.g. `["/path/main.ts"]` under bun. */
  argsPrefix: string[];
};

/**
 * Resolve argv to spawn `acpbot <sub> …` as a child of the current process.
 */
export function resolveAcpbotSpawn(
  env: NodeJS.ProcessEnv = process.env,
): AcpbotSpawn {
  const override = env.ACPBOT_BIN?.trim() || env.TACP_BIN?.trim();
  if (override) {
    return { command: override, argsPrefix: [] };
  }

  const exec = process.execPath;
  const base = basename(exec).toLowerCase();
  // Compiled binary: `./acpbot host` → execPath is acpbot
  if (base === "acpbot" || base.startsWith("acpbot-")) {
    return { command: exec, argsPrefix: [] };
  }

  // bun/node running a script: argv[1] is main.ts (or the entry)
  const script = process.argv[1];
  if (script && (script.endsWith(".ts") || script.endsWith(".js") || script.endsWith(".mjs"))) {
    return { command: exec, argsPrefix: [script] };
  }

  // Fallback: assume current execPath can take the subcommand
  return { command: exec, argsPrefix: [] };
}

/** Full argv for `acpbot <sub> [extra…]` (without the command itself). */
export function acpbotSubArgs(
  sub: string,
  extra: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const { command, argsPrefix } = resolveAcpbotSpawn(env);
  return { command, args: [...argsPrefix, sub, ...extra] };
}
