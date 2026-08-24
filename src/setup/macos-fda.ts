/**
 * macOS Full Disk Access (FDA) helpers for guided setup.
 *
 * macOS does not allow apps to grant themselves FDA. We can only:
 *   1. Probe whether this process can read TCC-protected paths
 *   2. Open System Settings → Privacy & Security → Full Disk Access
 *   3. Tell the operator which binary to add (+ toggle on)
 *
 * LaunchAgents run as the `acpbot` binary path — that path (not Terminal)
 * must be listed when host/worker run in the background.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Privacy pane URLs — Ventura+ first, then older System Preferences. */
export const FULL_DISK_ACCESS_SETTINGS_URLS = [
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
] as const;

/**
 * Paths that typically require Full Disk Access to list.
 * Success on any one ⇒ we treat FDA as granted for this process.
 */
export function fullDiskAccessProbePaths(
  home: string = homedir(),
): string[] {
  return [
    join(home, "Library", "Mail"),
    join(home, "Library", "Safari"),
    join(home, "Library", "Application Support", "com.apple.TCC"),
    join(home, "Library", "Cookies"),
  ];
}

/**
 * Best-effort FDA check for the **current process**.
 * Returns true if we can readdir a protected user Library path.
 * False negatives are rare; false positives are rare too (path missing ≠ denied).
 */
export function hasFullDiskAccess(options: {
  home?: string;
  /** Inject for tests: (path) => "ok" | "denied" | "missing" */
  probe?: (path: string) => "ok" | "denied" | "missing";
} = {}): boolean {
  const home = options.home ?? homedir();
  const probe =
    options.probe ??
    ((path: string): "ok" | "denied" | "missing" => {
      if (!existsSync(path)) return "missing";
      try {
        readdirSync(path);
        return "ok";
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code)
            : "";
        // EPERM / EACCES = TCC denial; ENOENT already handled
        if (code === "EPERM" || code === "EACCES") return "denied";
        // Other errors: treat as not granted
        return "denied";
      }
    });

  for (const path of fullDiskAccessProbePaths(home)) {
    const r = probe(path);
    if (r === "ok") return true;
  }
  // Missing paths or denials ⇒ treat as not granted
  return false;
}

/**
 * Open System Settings to Full Disk Access.
 * Returns true if `open` exited 0 for at least one URL.
 */
export function openFullDiskAccessSettings(options: {
  /** Inject for tests */
  runOpen?: (url: string) => boolean;
} = {}): boolean {
  const run =
    options.runOpen ??
    ((url: string) => {
      const r = spawnSync("open", [url], {
        encoding: "utf8",
        timeout: 5000,
      });
      return r.status === 0;
    });

  for (const url of FULL_DISK_ACCESS_SETTINGS_URLS) {
    if (run(url)) return true;
  }
  return false;
}

export function fullDiskAccessGuidance(binPath?: string): string {
  const bin = binPath?.trim() || "~/.local/bin/acpbot";
  return [
    "macOS Full Disk Access lets acpbot (and agents it spawns) read your",
    "real project folders under Desktop, Documents, Downloads, iCloud, etc.",
    "It does not register projects. Add each workspace with acpbot repo add",
    "(or during setup: browse into the project folder, not the parent).",
    "Without FDA, background LaunchAgents often see “Operation not permitted”.",
    "",
    "In System Settings → Privacy & Security → Full Disk Access:",
    `  1. Click + and add:  ${bin}`,
    "  2. Turn the toggle ON for acpbot",
    "  3. If you use bun from a terminal for dev, also add that Terminal app",
    "  4. After toggling, restart:  acpbot restart",
  ].join("\n");
}

export function isDarwinPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "darwin";
}
