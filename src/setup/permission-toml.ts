/**
 * Patch `permission_mode` in config.toml without rewriting unrelated content.
 *
 * Prefer `[features].permission_mode`; fall back to top-level `permission_mode`.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeConfigToml } from "../config-setup";
import type { PermissionMode } from "../env/types";

export function readConfigTomlBody(configPath: string): string {
  if (!existsSync(configPath)) {
    throw new Error(`config not found: ${configPath}`);
  }
  return readFileSync(configPath, "utf8");
}

/**
 * Replace or insert `permission_mode = "ask"|"bypass"` in the features table
 * (or top-level if no [features] section).
 */
export function replacePermissionModeInToml(
  tomlBody: string,
  mode: PermissionMode,
): string {
  const normalized = tomlBody.replace(/\r\n/g, "\n");
  const endsWithNl = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const valueLine = `permission_mode = "${mode}"  # ask | bypass`;

  // Prefer [features] section
  let featuresStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === "[features]") {
      featuresStart = i;
      break;
    }
  }

  if (featuresStart >= 0) {
    let featuresEnd = lines.length;
    for (let i = featuresStart + 1; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (/^\[[^\]]+\]/.test(t)) {
        featuresEnd = i;
        break;
      }
    }

    let replaced = false;
    for (let i = featuresStart + 1; i < featuresEnd; i++) {
      const t = lines[i]!.trim();
      // Match permission_mode = ... (allow comments / spaces)
      if (/^permission_mode\s*=/.test(t) || /^#\s*permission_mode\s*=/.test(t)) {
        lines[i] = valueLine;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      // Insert after [features] header (skip blank line if present)
      let insertAt = featuresStart + 1;
      while (insertAt < featuresEnd && lines[insertAt]!.trim() === "") {
        insertAt += 1;
      }
      lines.splice(insertAt, 0, valueLine);
    }
  } else {
    // Top-level key
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (/^permission_mode\s*=/.test(t) || /^#\s*permission_mode\s*=/.test(t)) {
        // Only top-level (before any [section])
        let beforeSection = true;
        for (let j = 0; j < i; j++) {
          if (/^\[[^\]]+\]/.test(lines[j]!.trim())) {
            beforeSection = false;
            break;
          }
        }
        if (beforeSection) {
          lines[i] = valueLine;
          replaced = true;
          break;
        }
      }
    }
    if (!replaced) {
      // Create [features] before first section or at end
      let insertAt = lines.length;
      for (let i = 0; i < lines.length; i++) {
        if (/^\[[^\]]+\]/.test(lines[i]!.trim())) {
          insertAt = i;
          break;
        }
      }
      const block = ["[features]", valueLine, ""];
      lines.splice(insertAt, 0, ...block);
    }
  }

  const joined = lines.join("\n");
  const cleaned = joined.replace(/\n{3,}/g, "\n\n");
  return endsWithNl || cleaned.length > 0
    ? cleaned.replace(/\n?$/, "\n")
    : cleaned;
}

export function writePermissionModeToConfig(
  configPath: string,
  mode: PermissionMode,
): void {
  const body = readConfigTomlBody(configPath);
  const next = replacePermissionModeInToml(body, mode);
  writeConfigToml(configPath, next);
}
