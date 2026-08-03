/**
 * Hot-reload safe fields from config.toml without restarting host/worker.
 *
 * Watches the TOML path (with debounce). On change, reloads via loadConfig
 * and mutates the live AcpbotConfig / catalog in place.
 *
 * Reloaded: repos, defaultAgent, permissionMode, ttsMode, mcpEnabled, skillRoots
 * Not reloaded: bot_token, storePath, stateDir, oauth bind (need restart)
 */
import { watch, type FSWatcher } from "node:fs";
import { loadConfig, applyConfigToEnv, type ProcessConfig } from "./config";
import type { Logger } from "./env/logger";
import type { AcpbotConfig } from "./env/types";

export type HotReloadableSnapshot = {
  repos: Record<string, string>;
  defaultAgent?: string;
  permissionMode?: AcpbotConfig["permissionMode"];
  ttsMode?: AcpbotConfig["ttsMode"];
  mcpEnabled?: boolean;
  skillRoots?: string[];
};

export function snapshotHotFields(cfg: {
  repos?: Record<string, string>;
  defaultAgent?: string;
  permissionMode?: AcpbotConfig["permissionMode"];
  ttsMode?: AcpbotConfig["ttsMode"];
  mcpEnabled?: boolean;
  skillRoots?: string[];
}): HotReloadableSnapshot {
  return {
    repos: { ...(cfg.repos ?? {}) },
    ...(cfg.defaultAgent !== undefined
      ? { defaultAgent: cfg.defaultAgent }
      : {}),
    ...(cfg.permissionMode !== undefined
      ? { permissionMode: cfg.permissionMode }
      : {}),
    ...(cfg.ttsMode !== undefined ? { ttsMode: cfg.ttsMode } : {}),
    ...(cfg.mcpEnabled !== undefined ? { mcpEnabled: cfg.mcpEnabled } : {}),
    ...(cfg.skillRoots !== undefined
      ? { skillRoots: [...cfg.skillRoots] }
      : {}),
  };
}

function sortedJson(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = o[k];
    return JSON.stringify(out);
  }
  if (Array.isArray(v)) return JSON.stringify([...v].map(String).sort());
  return JSON.stringify(v);
}

/**
 * Apply hot-reloadable fields onto a live config object.
 * Mutates `live` in place (including `live.repos` keys when that object is shared).
 */
export function applyHotReloadableConfig(
  live: AcpbotConfig,
  next: ProcessConfig | HotReloadableSnapshot,
): string[] {
  const changed: string[] = [];
  const nextRepos = next.repos ?? {};
  const prevRepos = live.repos ?? {};
  if (sortedJson(prevRepos) !== sortedJson(nextRepos)) {
    if (live.repos && typeof live.repos === "object") {
      for (const k of Object.keys(live.repos)) delete live.repos[k];
      Object.assign(live.repos, nextRepos);
    } else {
      live.repos = { ...nextRepos };
    }
    changed.push("repos");
  }

  if (
    next.defaultAgent !== undefined &&
    next.defaultAgent !== live.defaultAgent
  ) {
    live.defaultAgent = next.defaultAgent;
    changed.push("defaultAgent");
  }

  if (
    next.permissionMode !== undefined &&
    next.permissionMode !== live.permissionMode
  ) {
    live.permissionMode = next.permissionMode;
    changed.push("permissionMode");
  }

  if (next.ttsMode !== undefined && next.ttsMode !== live.ttsMode) {
    live.ttsMode = next.ttsMode;
    changed.push("ttsMode");
  }

  if (
    next.mcpEnabled !== undefined &&
    next.mcpEnabled !== live.mcpEnabled
  ) {
    live.mcpEnabled = next.mcpEnabled;
    changed.push("mcpEnabled");
  }

  if (
    next.skillRoots !== undefined &&
    sortedJson(next.skillRoots) !== sortedJson(live.skillRoots ?? [])
  ) {
    live.skillRoots = [...next.skillRoots];
    changed.push("skillRoots");
  }

  return changed;
}

/** Replace contents of a shared repos catalog map (host scheduler). */
export function replaceReposMap(
  target: Record<string, string>,
  next: Record<string, string>,
): boolean {
  if (sortedJson(target) === sortedJson(next)) return false;
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, next);
  return true;
}

export type ConfigWatchHandle = {
  close: () => void;
};

export type WatchConfigOptions = {
  configPath: string;
  /** Live config mutated on reload (worker env.config or host bag). */
  live: AcpbotConfig;
  /**
   * Optional shared catalog map used by the host scheduler.
   * When set, repos are written here as well as `live.repos`.
   */
  reposCatalog?: Record<string, string>;
  /** Debounce window for bursty editor writes (default 400ms). */
  debounceMs?: number;
  log?: Logger;
  /** Inject load for tests. */
  load?: () => ProcessConfig;
  /** When true (default), also publish ACPBOT_REPOS_JSON etc. via applyConfigToEnv. */
  applyEnv?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Called after a successful apply with non-empty changes. */
  onReloaded?: (changed: string[], next: ProcessConfig) => void;
};

/**
 * Watch config.toml and hot-apply safe fields. Returns a stop handle.
 */
export function watchConfigFile(options: WatchConfigOptions): ConfigWatchHandle {
  const log = options.log;
  const debounceMs = options.debounceMs ?? 400;
  const env = options.env ?? process.env;
  const load =
    options.load ??
    (() =>
      loadConfig({
        configPath: options.configPath,
        env,
        requireTelegram: false,
      }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let watcher: FSWatcher | undefined;

  const runReload = () => {
    if (closed) return;
    try {
      const next = load();
      const changed = applyHotReloadableConfig(options.live, next);
      if (options.reposCatalog) {
        const repoChanged = replaceReposMap(
          options.reposCatalog,
          next.repos ?? {},
        );
        if (repoChanged && !changed.includes("repos")) changed.push("repos");
      }
      // Keep live.repos pointing at catalog when both exist
      if (options.reposCatalog) {
        options.live.repos = options.reposCatalog;
      }
      if (changed.length === 0) {
        log?.debug("config reload: no hot-reloadable changes", {
          path: options.configPath,
        });
        return;
      }
      if (options.applyEnv !== false) {
        applyConfigToEnv(next, env);
      }
      log?.info("config reloaded", {
        path: options.configPath,
        changed,
        repos: Object.keys(next.repos ?? {}),
      });
      console.error(
        `acpbot config reloaded (${changed.join(", ")}): ${options.configPath}` +
          (changed.includes("repos")
            ? ` · repos=[${Object.keys(next.repos ?? {}).join(", ")}]`
            : ""),
      );
      options.onReloaded?.(changed, next);
    } catch (err) {
      log?.warn("config reload failed", {
        path: options.configPath,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(
        `acpbot config reload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(runReload, debounceMs);
  };

  try {
    watcher = watch(options.configPath, { persistent: false }, (event) => {
      // 'rename' is common for atomic saves; both should trigger reload
      if (event === "change" || event === "rename" || !event) schedule();
    });
    watcher.on("error", (err) => {
      log?.warn("config watch error", {
        path: options.configPath,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    log?.info("config watch started", { path: options.configPath });
  } catch (err) {
    log?.warn("config watch not available", {
      path: options.configPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        /* */
      }
    },
  };
}
