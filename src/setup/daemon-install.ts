/**
 * Install acpbot + acpbot-host as a user-level background service.
 * - macOS: LaunchAgent plists (~/Library/LaunchAgents)
 * - Linux: systemd --user units (~/.config/systemd/user)
 */
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type DaemonPlatform = "darwin" | "linux" | "unsupported";

export function detectDaemonPlatform(
  platform: NodeJS.Platform = process.platform,
): DaemonPlatform {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  return "unsupported";
}

/** Resolve absolute path to an executable on PATH or an absolute path. */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (name.includes("/") || name.includes("\\")) {
    const abs = resolve(name);
    return existsSync(abs) ? abs : undefined;
  }
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  // Common install locations for release binaries
  for (const dir of ["/usr/local/bin", "/opt/homebrew/bin", join(homedir(), ".local", "bin")]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export type InstallDaemonOptions = {
  configPath: string;
  workerBin?: string;
  hostBin?: string;
  /** Label / unit prefix */
  label?: string;
  env?: NodeJS.ProcessEnv;
  /** If true, load/start immediately */
  start?: boolean;
  logDir?: string;
};

export type InstallDaemonResult = {
  platform: DaemonPlatform;
  files: string[];
  messages: string[];
  started: boolean;
};

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function launchAgentPlist(opts: {
  label: string;
  programArgs: string[];
  workingDirectory: string;
  logOut: string;
  logErr: string;
  env?: Record<string, string>;
}): string {
  const argsXml = opts.programArgs
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  const envXml = opts.env
    ? Object.entries(opts.env)
        .map(
          ([k, v]) =>
            `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`,
        )
        .join("\n")
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.logOut)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.logErr)}</string>
${
  envXml
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envXml}\n  </dict>\n`
    : ""
}</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function systemdUserUnit(opts: {
  description: string;
  execStart: string;
  workingDirectory: string;
  envFile?: string;
}): string {
  return `[Unit]
Description=${opts.description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${opts.workingDirectory}
ExecStart=${opts.execStart}
Restart=on-failure
RestartSec=3
${opts.envFile ? `EnvironmentFile=${opts.envFile}\n` : ""}
[Install]
WantedBy=default.target
`;
}

/**
 * Install host + worker user services. Does not require root.
 */
export function installUserDaemons(
  options: InstallDaemonOptions,
): InstallDaemonResult {
  const platform = detectDaemonPlatform();
  const messages: string[] = [];
  const files: string[] = [];
  const env = options.env ?? process.env;
  const label = options.label ?? "app.acpbot";
  const home = env.HOME ?? homedir();
  const configPath = resolve(options.configPath);
  const worker =
    options.workerBin ??
    resolveExecutable("acpbot", env) ??
    resolveExecutable("acpbot", env);
  const host =
    options.hostBin ??
    resolveExecutable("acpbot-host", env);

  if (!worker || !host) {
    return {
      platform,
      files: [],
      messages: [
        "Could not find acpbot and/or acpbot-host on PATH.",
        "Install release binaries first, then re-run setup.",
        "  PATH should include e.g. /usr/local/bin",
      ],
      started: false,
    };
  }

  const logDir =
    options.logDir ?? join(home, ".local", "share", "acpbot", "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const workDir = dirname(configPath);
  const start = options.start !== false;

  if (platform === "darwin") {
    const agentsDir = join(home, "Library", "LaunchAgents");
    mkdirSync(agentsDir, { recursive: true });
    const hostLabel = `${label}.host`;
    const workerLabel = `${label}.worker`;
    const hostPlist = join(agentsDir, `${hostLabel}.plist`);
    const workerPlist = join(agentsDir, `${workerLabel}.plist`);

    writeFileSync(
      hostPlist,
      launchAgentPlist({
        label: hostLabel,
        programArgs: [host, "--config", configPath],
        workingDirectory: workDir,
        logOut: join(logDir, "host.out.log"),
        logErr: join(logDir, "host.err.log"),
      }),
      "utf8",
    );
    writeFileSync(
      workerPlist,
      launchAgentPlist({
        label: workerLabel,
        programArgs: [worker, "--config", configPath],
        workingDirectory: workDir,
        logOut: join(logDir, "worker.out.log"),
        logErr: join(logDir, "worker.err.log"),
      }),
      "utf8",
    );
    files.push(hostPlist, workerPlist);
    messages.push(`Wrote LaunchAgents:\n  ${hostPlist}\n  ${workerPlist}`);
    messages.push(`Logs: ${logDir}`);

    let started = false;
    if (start) {
      // Unload first (ignore errors), then load
      for (const plist of [hostPlist, workerPlist]) {
        spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, plist], {
          encoding: "utf8",
        });
        const r = spawnSync(
          "launchctl",
          ["bootstrap", `gui/${process.getuid?.() ?? 501}`, plist],
          { encoding: "utf8" },
        );
        if (r.status !== 0) {
          // Fallback older launchctl load
          const r2 = spawnSync("launchctl", ["load", "-w", plist], {
            encoding: "utf8",
          });
          if (r2.status !== 0) {
            messages.push(
              `launchctl failed for ${plist}: ${r.stderr || r2.stderr || r.stdout}`,
            );
          } else {
            started = true;
          }
        } else {
          started = true;
        }
      }
      if (started) {
        messages.push("Services loaded (KeepAlive). Check:");
        messages.push(`  launchctl print gui/$(id -u)/${hostLabel}`);
        messages.push(`  launchctl print gui/$(id -u)/${workerLabel}`);
      }
    } else {
      messages.push(
        `Load later:\n  launchctl bootstrap gui/$(id -u) ${shellQuote(hostPlist)}\n  launchctl bootstrap gui/$(id -u) ${shellQuote(workerPlist)}`,
      );
    }
    return { platform, files, messages, started };
  }

  if (platform === "linux") {
    const unitDir = join(home, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    const hostUnit = join(unitDir, "acpbot-host.service");
    const workerUnit = join(unitDir, "acpbot.service");
    writeFileSync(
      hostUnit,
      systemdUserUnit({
        description: "acpbot host (agent owner)",
        execStart: `${host} --config ${configPath}`,
        workingDirectory: workDir,
      }),
      "utf8",
    );
    writeFileSync(
      workerUnit,
      systemdUserUnit({
        description: "acpbot worker (Telegram)",
        execStart: `${worker} --config ${configPath}`,
        workingDirectory: workDir,
      }),
      "utf8",
    );
    files.push(hostUnit, workerUnit);
    messages.push(`Wrote systemd user units:\n  ${hostUnit}\n  ${workerUnit}`);
    messages.push(`Logs: journalctl --user -u acpbot-host -u acpbot -f`);

    let started = false;
    if (start) {
      spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
      const en = spawnSync(
        "systemctl",
        ["--user", "enable", "--now", "acpbot-host.service", "acpbot.service"],
        { encoding: "utf8" },
      );
      if (en.status === 0) {
        started = true;
        messages.push("Enabled and started user services.");
      } else {
        messages.push(
          `systemctl failed: ${en.stderr || en.stdout || "unknown"}\n` +
            `  You may need: loginctl enable-linger $USER`,
        );
      }
    } else {
      messages.push(
        `Start later:\n  systemctl --user enable --now acpbot-host acpbot`,
      );
    }
    return { platform, files, messages, started };
  }

  return {
    platform: "unsupported",
    files: [],
    messages: [
      `Automatic daemon install is not supported on ${process.platform}.`,
      "Run acpbot-host and acpbot manually, or add your own service unit.",
    ],
    started: false,
  };
}

export function uninstallUserDaemons(
  options: { label?: string; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const platform = detectDaemonPlatform();
  const home = options.env?.HOME ?? homedir();
  const label = options.label ?? "app.acpbot";
  const msgs: string[] = [];

  if (platform === "darwin") {
    const agentsDir = join(home, "Library", "LaunchAgents");
    for (const suffix of ["host", "worker"]) {
      const plist = join(agentsDir, `${label}.${suffix}.plist`);
      if (existsSync(plist)) {
        spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, plist]);
        spawnSync("launchctl", ["unload", "-w", plist]);
        try {
          unlinkSync(plist);
          msgs.push(`Removed ${plist}`);
        } catch {
          msgs.push(`Could not remove ${plist}`);
        }
      }
    }
  } else if (platform === "linux") {
    spawnSync("systemctl", ["--user", "disable", "--now", "acpbot.service", "acpbot-host.service"]);
    const unitDir = join(home, ".config", "systemd", "user");
    for (const name of ["acpbot.service", "acpbot-host.service"]) {
      const p = join(unitDir, name);
      if (existsSync(p)) {
        try {
          unlinkSync(p);
          msgs.push(`Removed ${p}`);
        } catch {
          /* */
        }
      }
    }
    spawnSync("systemctl", ["--user", "daemon-reload"]);
  }
  return msgs;
}

