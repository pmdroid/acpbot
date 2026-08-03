/**
 * CLI: install | start | stop | restart | status | uninstall
 * for background host + worker services (same `acpbot` binary).
 *
 *   acpbot install|start|stop|restart|status
 *   acpbot start --host     # host only
 *   acpbot start --worker   # worker only
 */
import { ensureAcpbotLayout, resolveConfigWritePath } from "../config-setup";
import type { LoadConfigOptions } from "../config";
import {
  installUserDaemons,
  startUserDaemons,
  stopUserDaemons,
  statusUserDaemons,
  uninstallUserDaemons,
  type ServiceTarget,
} from "./daemon-install";

export type ServiceCliAction =
  | "install"
  | "start"
  | "stop"
  | "restart"
  | "status"
  | "uninstall";

const ACTIONS = new Set<ServiceCliAction>([
  "install",
  "start",
  "stop",
  "restart",
  "status",
  "uninstall",
]);

export function parseServiceCli(
  argv: string[] = process.argv,
): { action: ServiceCliAction; target: ServiceTarget } | null {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("-")));
  const cmd = args.find((a) => !a.startsWith("-"));
  if (!cmd || !ACTIONS.has(cmd as ServiceCliAction)) return null;

  let target: ServiceTarget = "all";
  if (flags.has("--host") || flags.has("--host-only")) target = "host";
  if (flags.has("--worker") || flags.has("--worker-only")) target = "worker";
  // both flags → all
  if (
    (flags.has("--host") || flags.has("--host-only")) &&
    (flags.has("--worker") || flags.has("--worker-only"))
  ) {
    target = "all";
  }
  return { action: cmd as ServiceCliAction, target };
}

export function isServiceCliCommand(argv: string[] = process.argv): boolean {
  return parseServiceCli(argv) !== null;
}

export async function runServiceCli(
  argv: string[] = process.argv,
  options: LoadConfigOptions = {},
): Promise<number> {
  const parsed = parseServiceCli(argv);
  if (!parsed) return 2;

  const layout = ensureAcpbotLayout(options);
  const configPath =
    options.configPath ??
    resolveConfigWritePath(options) ??
    layout.configPath;
  const base = {
    configPath,
    env: (options.env ?? process.env) as NodeJS.ProcessEnv,
    label: "app.acpbot",
    target: parsed.target,
  };

  const print = (lines: string[]) => {
    for (const line of lines) console.error(line);
  };

  switch (parsed.action) {
    case "install": {
      const r = installUserDaemons({
        ...base,
        start: true,
      });
      print(r.messages);
      return r.files.length > 0 || r.started ? 0 : 1;
    }
    case "start": {
      const r = startUserDaemons(base);
      print(r.messages);
      return r.ok ? 0 : 1;
    }
    case "stop": {
      const r = stopUserDaemons(base);
      print(r.messages);
      return r.ok ? 0 : 1;
    }
    case "restart": {
      const stop = stopUserDaemons(base);
      print(stop.messages);
      // brief pause so sockets release
      await Bun.sleep(400);
      const start = startUserDaemons(base);
      print(start.messages);
      return start.ok ? 0 : 1;
    }
    case "status": {
      const r = statusUserDaemons(base);
      print(r.messages);
      return r.ok ? 0 : 1;
    }
    case "uninstall": {
      const msgs = uninstallUserDaemons(base);
      print(msgs.length ? msgs : ["Nothing to uninstall."]);
      return 0;
    }
    default:
      return 2;
  }
}

export function serviceCliHelp(): string {
  return `acpbot service commands:

  install     Write + enable LaunchAgents (macOS) or systemd user units (Linux)
              Installs BOTH: \`acpbot host\` and \`acpbot worker\`
  start       Start services
  stop        Stop services
  restart     Stop then start
  status      Show status
  uninstall   Stop and remove unit files

Flags:
  --host / --host-only      Only host service
  --worker / --worker-only  Only worker service
  --config PATH             Config file (default ~/.config/acpbot/config.toml)

Examples:
  acpbot install
  acpbot start
  acpbot stop
  acpbot restart
  acpbot start --worker
  acpbot status
`;
}
