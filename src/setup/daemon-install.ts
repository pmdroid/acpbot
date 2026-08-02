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

/** Which service(s) to control. */
export type ServiceTarget = "host" | "worker" | "all";

export function detectDaemonPlatform(
  platform: NodeJS.Platform = process.platform,
): DaemonPlatform {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  return "unsupported";
}

function guiDomain(env: NodeJS.ProcessEnv = process.env): string {
  const uid = process.getuid?.() ?? (Number(env.UID) || 501);
  return `gui/${uid}`;
}

export function servicePaths(
  options: { label?: string; env?: NodeJS.ProcessEnv } = {},
): {
  platform: DaemonPlatform;
  hostLabel: string;
  workerLabel: string;
  hostPlist: string;
  workerPlist: string;
  hostUnit: string;
  workerUnit: string;
  logDir: string;
} {
  const platform = detectDaemonPlatform();
  const home = options.env?.HOME ?? homedir();
  const label = options.label ?? "app.acpbot";
  const hostLabel = `${label}.host`;
  const workerLabel = `${label}.worker`;
  const agentsDir = join(home, "Library", "LaunchAgents");
  const unitDir = join(home, ".config", "systemd", "user");
  const logDir = join(home, ".local", "share", "acpbot", "logs");
  return {
    platform,
    hostLabel,
    workerLabel,
    hostPlist: join(agentsDir, `${hostLabel}.plist`),
    workerPlist: join(agentsDir, `${workerLabel}.plist`),
    hostUnit: join(unitDir, "acpbot-host.service"),
    workerUnit: join(unitDir, "acpbot.service"),
    logDir,
  };
}

function targetsFor(
  target: ServiceTarget,
  paths: ReturnType<typeof servicePaths>,
): { kind: "host" | "worker"; darwinPlist: string; darwinLabel: string; linuxUnit: string; linuxName: string }[] {
  const host = {
    kind: "host" as const,
    darwinPlist: paths.hostPlist,
    darwinLabel: paths.hostLabel,
    linuxUnit: paths.hostUnit,
    linuxName: "acpbot-host.service",
  };
  const worker = {
    kind: "worker" as const,
    darwinPlist: paths.workerPlist,
    darwinLabel: paths.workerLabel,
    linuxUnit: paths.workerUnit,
    linuxName: "acpbot.service",
  };
  if (target === "host") return [host];
  if (target === "worker") return [worker];
  return [host, worker];
}

export type ControlResult = {
  platform: DaemonPlatform;
  messages: string[];
  ok: boolean;
};

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
  /** Which services to install/start (default all). */
  target?: ServiceTarget;
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
  /** Extra Environment= lines (already KEY=value). */
  environment?: Record<string, string>;
}): string {
  const envLines = opts.environment
    ? Object.entries(opts.environment)
        .map(([k, v]) => `Environment=${k}=${v}`)
        .join("\n") + "\n"
    : "";
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
${envLines}${opts.envFile ? `EnvironmentFile=${opts.envFile}\n` : ""}
[Install]
WantedBy=default.target
`;
}

/**
 * PATH for background services — LaunchAgents default to a minimal system PATH
 * that does not include ~/.local/bin or agent CLIs (grok, claude, …).
 */
export function servicePathEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const home = env.HOME ?? homedir();
  const extras = [
    join(home, ".local", "bin"),
    join(home, ".grok", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const current = env.PATH?.split(":").filter(Boolean) ?? [];
  const system = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const merged = [...extras, ...current, ...system];
  const seen = new Set<string>();
  const path = merged
    .filter((d) => {
      if (!d || seen.has(d)) return false;
      seen.add(d);
      return true;
    })
    .join(":");
  const out: Record<string, string> = { PATH: path, HOME: home };
  if (env.ACPBOT_CONFIG?.trim()) out.ACPBOT_CONFIG = env.ACPBOT_CONFIG.trim();
  return out;
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
  const serviceEnv = servicePathEnv(env);

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
        env: serviceEnv,
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
        env: serviceEnv,
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
        environment: serviceEnv,
      }),
      "utf8",
    );
    writeFileSync(
      workerUnit,
      systemdUserUnit({
        description: "acpbot worker (Telegram)",
        execStart: `${worker} --config ${configPath}`,
        workingDirectory: workDir,
        environment: serviceEnv,
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

export function startUserDaemons(
  options: {
    label?: string;
    env?: NodeJS.ProcessEnv;
    target?: ServiceTarget;
  } = {},
): ControlResult {
  const paths = servicePaths(options);
  const messages: string[] = [];
  const env = options.env ?? process.env;
  const list = targetsFor(options.target ?? "all", paths);

  if (paths.platform === "darwin") {
    const domain = guiDomain(env);
    let ok = true;
    // Host first so worker can connect
    for (const t of list) {
      if (!existsSync(t.darwinPlist)) {
        messages.push(
          `Missing ${t.darwinPlist} — run: acpbot-host install  (or acpbot setup)`,
        );
        ok = false;
        continue;
      }
      spawnSync("launchctl", ["bootout", domain, t.darwinPlist], {
        encoding: "utf8",
      });
      let r = spawnSync("launchctl", ["bootstrap", domain, t.darwinPlist], {
        encoding: "utf8",
      });
      if (r.status !== 0) {
        r = spawnSync("launchctl", ["load", "-w", t.darwinPlist], {
          encoding: "utf8",
        });
      }
      if (r.status !== 0) {
        messages.push(
          `Failed to start ${t.darwinLabel}: ${r.stderr || r.stdout || "unknown"}`,
        );
        ok = false;
      } else {
        messages.push(`Started ${t.darwinLabel}`);
      }
    }
    return { platform: paths.platform, messages, ok };
  }

  if (paths.platform === "linux") {
    let ok = true;
    for (const t of list) {
      if (!existsSync(t.linuxUnit)) {
        messages.push(
          `Missing ${t.linuxUnit} — run: acpbot-host install  (or acpbot setup)`,
        );
        ok = false;
        continue;
      }
    }
    spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
    const names = list.map((t) => t.linuxName);
    // enable host first
    const ordered =
      options.target === "worker"
        ? names
        : options.target === "host"
          ? names
          : ["acpbot-host.service", "acpbot.service"].filter((n) =>
              names.includes(n),
            );
    const r = spawnSync(
      "systemctl",
      ["--user", "enable", "--now", ...ordered],
      { encoding: "utf8" },
    );
    if (r.status !== 0) {
      messages.push(
        `systemctl start failed: ${r.stderr || r.stdout || "unknown"}`,
      );
      messages.push("  Tip: loginctl enable-linger $USER");
      ok = false;
    } else {
      for (const n of ordered) messages.push(`Started ${n}`);
    }
    return { platform: paths.platform, messages, ok };
  }

  return {
    platform: paths.platform,
    messages: ["Service control not supported on this OS."],
    ok: false,
  };
}

export function stopUserDaemons(
  options: {
    label?: string;
    env?: NodeJS.ProcessEnv;
    target?: ServiceTarget;
  } = {},
): ControlResult {
  const paths = servicePaths(options);
  const messages: string[] = [];
  const env = options.env ?? process.env;
  const list = targetsFor(options.target ?? "all", paths);
  // Stop worker first so it does not flap while host is still up
  const ordered = [...list].reverse();

  if (paths.platform === "darwin") {
    const domain = guiDomain(env);
    let ok = true;
    for (const t of ordered) {
      if (!existsSync(t.darwinPlist)) {
        messages.push(`Not installed: ${t.darwinLabel}`);
        continue;
      }
      const r = spawnSync("launchctl", ["bootout", domain, t.darwinPlist], {
        encoding: "utf8",
      });
      if (r.status !== 0) {
        spawnSync("launchctl", ["unload", "-w", t.darwinPlist], {
          encoding: "utf8",
        });
      }
      messages.push(`Stopped ${t.darwinLabel}`);
    }
    return { platform: paths.platform, messages, ok };
  }

  if (paths.platform === "linux") {
    const names = ordered.map((t) => t.linuxName);
    const r = spawnSync("systemctl", ["--user", "stop", ...names], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      messages.push(`systemctl stop: ${r.stderr || r.stdout || "ok/partial"}`);
    }
    for (const n of names) messages.push(`Stopped ${n}`);
    return { platform: paths.platform, messages, ok: true };
  }

  return {
    platform: paths.platform,
    messages: ["Service control not supported on this OS."],
    ok: false,
  };
}

export function statusUserDaemons(
  options: {
    label?: string;
    env?: NodeJS.ProcessEnv;
    target?: ServiceTarget;
  } = {},
): ControlResult {
  const paths = servicePaths(options);
  const messages: string[] = [];
  const env = options.env ?? process.env;
  const list = targetsFor(options.target ?? "all", paths);
  let ok = true;

  if (paths.platform === "darwin") {
    const domain = guiDomain(env);
    for (const t of list) {
      if (!existsSync(t.darwinPlist)) {
        messages.push(`${t.kind}: not installed (${t.darwinPlist})`);
        ok = false;
        continue;
      }
      const r = spawnSync(
        "launchctl",
        ["print", `${domain}/${t.darwinLabel}`],
        { encoding: "utf8" },
      );
      if (r.status === 0) {
        const state =
          r.stdout?.match(/state = (\w+)/)?.[1] ??
          (r.stdout?.includes("pid =") ? "running" : "loaded");
        const pid = r.stdout?.match(/pid = (\d+)/)?.[1];
        messages.push(
          `${t.kind}: ${state}${pid ? ` (pid ${pid})` : ""} — ${t.darwinLabel}`,
        );
      } else {
        messages.push(`${t.kind}: not loaded — ${t.darwinLabel}`);
        ok = false;
      }
    }
    messages.push(`Logs: ${paths.logDir}`);
    return { platform: paths.platform, messages, ok };
  }

  if (paths.platform === "linux") {
    for (const t of list) {
      if (!existsSync(t.linuxUnit)) {
        messages.push(`${t.kind}: not installed (${t.linuxUnit})`);
        ok = false;
        continue;
      }
      const r = spawnSync(
        "systemctl",
        ["--user", "is-active", t.linuxName],
        { encoding: "utf8" },
      );
      const state = (r.stdout || r.stderr || "unknown").trim();
      messages.push(`${t.kind}: ${state} — ${t.linuxName}`);
      if (state !== "active") ok = false;
    }
    messages.push("Logs: journalctl --user -u acpbot-host -u acpbot -f");
    return { platform: paths.platform, messages, ok };
  }

  return {
    platform: paths.platform,
    messages: ["Service status not supported on this OS."],
    ok: false,
  };
}

export function uninstallUserDaemons(
  options: {
    label?: string;
    env?: NodeJS.ProcessEnv;
    target?: ServiceTarget;
  } = {},
): string[] {
  const stop = stopUserDaemons(options);
  const msgs = [...stop.messages];
  const paths = servicePaths(options);
  const list = targetsFor(options.target ?? "all", paths);

  if (paths.platform === "darwin") {
    for (const t of list) {
      if (existsSync(t.darwinPlist)) {
        try {
          unlinkSync(t.darwinPlist);
          msgs.push(`Removed ${t.darwinPlist}`);
        } catch {
          msgs.push(`Could not remove ${t.darwinPlist}`);
        }
      }
    }
  } else if (paths.platform === "linux") {
    const names = list.map((t) => t.linuxName);
    spawnSync("systemctl", ["--user", "disable", ...names], {
      encoding: "utf8",
    });
    for (const t of list) {
      if (existsSync(t.linuxUnit)) {
        try {
          unlinkSync(t.linuxUnit);
          msgs.push(`Removed ${t.linuxUnit}`);
        } catch {
          /* */
        }
      }
    }
    spawnSync("systemctl", ["--user", "daemon-reload"]);
  }
  return msgs;
}

