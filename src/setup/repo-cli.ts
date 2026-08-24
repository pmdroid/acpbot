/**
 * CLI: acpbot repo | repos
 *
 * Manage `[repos]` in config.toml (workspace roots for `/new`).
 * Interactive TUI with folder browser, plus non-interactive subcommands.
 */
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  ensureAcpbotLayout,
  resolveConfigWritePath,
} from "../config-setup";
import {
  homeDir,
  loadConfig,
  resolvePath,
  type LoadConfigOptions,
} from "../config";
import { pickDirectoryPath, isDirectory, expandTilde } from "./folder-browser";
import {
  isValidRepoKey,
  parseReposFromToml,
  readConfigTomlBody,
  writeReposToConfig,
} from "./repos-toml";

export function isRepoCliCommand(argv: string[] = process.argv): boolean {
  const a = argv.slice(2)[0]?.toLowerCase();
  return a === "repo" || a === "repos";
}

export function repoCliHelp(): string {
  return `Workspace repos ([repos] in config.toml — required before /new)
  acpbot repo                 Interactive manager (list / add / edit / remove)
  acpbot repo list            List configured repos
  acpbot repo add [key] [path]
                              Add or replace a repo (folder browser if no path)
  acpbot repo set <key> [path]
                              Same as add (set path for key)
  acpbot repo remove <key>    Remove a repo key
  acpbot repo browse          Browse for a folder, then set key
  acpbot repo path <key>      Print absolute path for a key
  acpbot repos …              Alias of repo

Notes:
  • You cannot start a Telegram session until at least one repo exists
  • Each key is one project folder (cwd). A parent like ~/Projects is not enough
  • Browse into the project, then Use this folder; add more with acpbot repo add
  • Paths must be existing directories (absolute or ~/…)
  • Host/worker hot-reload [repos]; /new sees new keys without restart
  • Config: ~/.config/acpbot/config.toml (or $ACPBOT_CONFIG)`;
}

function cancelled(v: unknown): boolean {
  return p.isCancel(v);
}

function abort(): never {
  p.cancel("Cancelled.");
  process.exit(0);
}

function loadReposMap(
  configPath: string,
  options: LoadConfigOptions,
): { repos: Record<string, string>; configPath: string } {
  const env = options.env ?? process.env;
  let repos: Record<string, string> = {};
  if (existsSync(configPath)) {
    try {
      const body = readConfigTomlBody(configPath);
      repos = parseReposFromToml(body);
    } catch {
      /* fall through to loadConfig */
    }
  }
  // Prefer resolved paths from loadConfig when available
  try {
    const cfg = loadConfig({
      ...options,
      configPath,
      requireTelegram: false,
    });
    if (cfg.repos) repos = { ...cfg.repos };
  } catch {
    // expand ~ for parsed values
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(repos)) {
      resolved[k] = resolvePath(v, env);
    }
    repos = resolved;
  }
  return { repos: { ...repos }, configPath };
}

function printList(repos: Record<string, string>, configPath: string): void {
  const keys = Object.keys(repos).sort((a, b) => a.localeCompare(b));
  if (keys.length === 0) {
    console.log("No repos configured. /new cannot start a session until you add one.");
    console.log(`Config: ${configPath}`);
    console.log("Add one: acpbot repo add");
    return;
  }
  console.log(`Repos (${keys.length}) — ${configPath}`);
  for (const k of keys) {
    const path = repos[k]!;
    const ok = isDirectory(path) ? "" : "  ⚠ missing";
    console.log(`  ${k.padEnd(16)} ${path}${ok}`);
  }
}

function saveRepos(
  configPath: string,
  repos: Record<string, string>,
): void {
  writeReposToConfig(configPath, repos);
  console.log(`Saved [repos] → ${configPath}`);
  console.log(
    "Hot-reloaded by running host/worker within ~1s (no restart needed for /new).",
  );
}

function resolveRepoPath(
  raw: string,
  env: NodeJS.ProcessEnv,
): string {
  return resolvePath(expandTilde(raw.trim(), homeDir(env)), env);
}

/** Empty text field — only a placeholder hint, never a guessed prefill. */
async function promptKey(opts?: {
  message?: string;
  placeholder?: string;
}): Promise<string | null> {
  const key = await p.text({
    message: opts?.message ?? "Repo key (short label in /new)",
    placeholder: opts?.placeholder ?? "demo",
    validate: (v) => {
      const t = String(v ?? "").trim();
      if (!t) return "Required";
      if (!isValidRepoKey(t)) {
        return "Use letters/digits/_-./ starting with alnum (max 64)";
      }
      return undefined;
    },
  });
  if (cancelled(key)) return null;
  return String(key).trim();
}

async function runInteractive(
  configPath: string,
  options: LoadConfigOptions,
): Promise<number> {
  p.intro("acpbot repo");
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
  let { repos } = loadReposMap(configPath, options);

  for (;;) {
    const keys = Object.keys(repos).sort((a, b) => a.localeCompare(b));
    if (keys.length === 0) {
      p.log.message(
        "No workspace repos yet. Add a project folder (not the parent ~/Projects or ~/code) so /new can start a session.",
      );
    } else {
      p.log.info(
        keys.map((k) => `${k} → ${repos[k]}`).join("\n"),
      );
    }

    const action = await p.select({
      message: "Repos",
      options: [
        { value: "add", label: "Add repo…", hint: "folder browser" },
        ...(keys.length > 0
          ? [
              { value: "edit", label: "Edit path…", hint: "change folder for a key" },
              { value: "rename", label: "Rename key…" },
              { value: "remove", label: "Remove repo…" },
            ]
          : []),
        { value: "list", label: "Print list" },
        { value: "done", label: "Done" },
      ],
      initialValue: keys.length === 0 ? "add" : "done",
    });
    if (cancelled(action)) {
      p.cancel("Cancelled.");
      return 0;
    }

    if (action === "done") {
      p.outro(
        keys.length
          ? `${keys.length} repo(s) in ${configPath}`
          : "No repos configured",
      );
      return 0;
    }

    if (action === "list") {
      printList(repos, configPath);
      continue;
    }

    if (action === "add") {
      const key = await promptKey();
      if (!key) abort();
      if (repos[key]) {
        const overwrite = await p.confirm({
          message: `Key "${key}" exists (${repos[key]}). Replace path?`,
          initialValue: false,
        });
        if (cancelled(overwrite)) abort();
        if (!overwrite) continue;
      }
      const path = await pickDirectoryPath({
        message: `Folder for repo "${key}"`,
        // browse starts at $HOME; type path is empty (placeholder only)
        startDir: homeDir(env),
        env,
      });
      if (!path) abort();
      repos[key] = path;
      saveRepos(configPath, repos);
      p.log.success(`${key} → ${path}`);
      continue;
    }

    if (action === "edit") {
      const keyPick = await p.select({
        message: "Which repo?",
        options: keys.map((k) => ({
          value: k,
          label: k,
          hint: repos[k],
        })),
      });
      if (cancelled(keyPick)) abort();
      const key = String(keyPick);
      const path = await pickDirectoryPath({
        message: `New folder for "${key}"`,
        // Start browser near the current path; typed path stays empty
        startDir: repos[key],
        env,
      });
      if (!path) abort();
      repos[key] = path;
      saveRepos(configPath, repos);
      p.log.success(`${key} → ${path}`);
      continue;
    }

    if (action === "rename") {
      const keyPick = await p.select({
        message: "Rename which key?",
        options: keys.map((k) => ({
          value: k,
          label: k,
          hint: repos[k],
        })),
      });
      if (cancelled(keyPick)) abort();
      const oldKey = String(keyPick);
      const newKey = await promptKey({
        message: `New key for "${oldKey}"`,
        placeholder: oldKey,
      });
      if (!newKey) abort();
      if (newKey !== oldKey && repos[newKey]) {
        p.log.error(`Key "${newKey}" already exists`);
        continue;
      }
      if (newKey !== oldKey) {
        repos[newKey] = repos[oldKey]!;
        delete repos[oldKey];
        saveRepos(configPath, repos);
        p.log.success(`renamed ${oldKey} → ${newKey}`);
      }
      continue;
    }

    if (action === "remove") {
      const keyPick = await p.select({
        message: "Remove which repo?",
        options: [
          ...keys.map((k) => ({
            value: k,
            label: k,
            hint: repos[k],
          })),
          { value: "__cancel__", label: "Cancel" },
        ],
      });
      if (cancelled(keyPick) || keyPick === "__cancel__") continue;
      const key = String(keyPick);
      const ok = await p.confirm({
        message: `Remove "${key}" (${repos[key]})?`,
        initialValue: false,
      });
      if (cancelled(ok) || !ok) continue;
      delete repos[key];
      saveRepos(configPath, repos);
      p.log.success(`removed ${key}`);
      continue;
    }
  }
}

export async function runRepoCli(
  argv: string[] = process.argv,
  options: LoadConfigOptions = {},
): Promise<number> {
  const args = argv.slice(2);
  // args[0] = repo|repos
  const sub = (args[1] ?? "").toLowerCase();
  const rest = args.slice(2);

  if (
    sub === "help" ||
    sub === "-h" ||
    sub === "--help" ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    console.log(repoCliHelp());
    return 0;
  }

  const layout = ensureAcpbotLayout(options);
  const configPath =
    options.configPath ??
    resolveConfigWritePath(options) ??
    layout.configPath;
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;

  if (!existsSync(configPath)) {
    console.error(`config not found: ${configPath}`);
    console.error("Run `acpbot setup` first.");
    return 1;
  }

  // Interactive menu when no subcommand
  if (!sub) {
    return runInteractive(configPath, { ...options, configPath, env });
  }

  if (sub === "list" || sub === "ls") {
    const { repos } = loadReposMap(configPath, { ...options, configPath, env });
    printList(repos, configPath);
    return 0;
  }

  if (sub === "path") {
    const key = rest[0]?.trim();
    if (!key) {
      console.error("Usage: acpbot repo path <key>");
      return 2;
    }
    const { repos } = loadReposMap(configPath, { ...options, configPath, env });
    const path = repos[key];
    if (!path) {
      console.error(`unknown repo key: ${key}`);
      return 1;
    }
    console.log(path);
    return 0;
  }

  if (sub === "remove" || sub === "rm" || sub === "delete") {
    const key = rest[0]?.trim();
    if (!key) {
      console.error("Usage: acpbot repo remove <key>");
      return 2;
    }
    const { repos } = loadReposMap(configPath, { ...options, configPath, env });
    if (!repos[key]) {
      console.error(`unknown repo key: ${key}`);
      return 1;
    }
    delete repos[key];
    saveRepos(configPath, repos);
    return 0;
  }

  if (sub === "browse") {
    // browse → pick folder → key → save
    if (!process.stdin.isTTY) {
      console.error("browse requires a TTY; use: acpbot repo add <key> <path>");
      return 2;
    }
    p.intro("acpbot repo browse");
    const { repos } = loadReposMap(configPath, { ...options, configPath, env });
    const path = await pickDirectoryPath({
      message: "Choose workspace folder",
      startDir: homeDir(env),
      env,
    });
    if (!path) {
      p.cancel("Cancelled.");
      return 0;
    }
    const key = await promptKey({
      placeholder: isValidRepoKey(basename(path)) ? basename(path) : "demo",
    });
    if (!key) {
      p.cancel("Cancelled.");
      return 0;
    }
    repos[key] = path;
    saveRepos(configPath, repos);
    p.outro(`${key} → ${path}`);
    return 0;
  }

  if (sub === "add" || sub === "set" || sub === "edit") {
    let key = rest[0]?.trim();
    let pathArg = rest[1]?.trim();

    // Non-interactive: need key + path
    if (key && pathArg) {
      if (!isValidRepoKey(key)) {
        console.error(`invalid repo key: ${key}`);
        return 2;
      }
      const abs = resolveRepoPath(pathArg, env);
      if (!isDirectory(abs)) {
        console.error(`not a directory: ${abs}`);
        return 1;
      }
      const { repos } = loadReposMap(configPath, {
        ...options,
        configPath,
        env,
      });
      repos[key] = abs;
      saveRepos(configPath, repos);
      console.log(`${key} → ${abs}`);
      return 0;
    }

    // Interactive add
    if (!process.stdin.isTTY) {
      console.error("Usage: acpbot repo add <key> <path>");
      return 2;
    }

    p.intro(`acpbot repo ${sub}`);
    const { repos } = loadReposMap(configPath, { ...options, configPath, env });

    if (!key) {
      const k = await promptKey();
      if (!k) {
        p.cancel("Cancelled.");
        return 0;
      }
      key = k;
    } else if (!isValidRepoKey(key)) {
      console.error(`invalid repo key: ${key}`);
      return 2;
    }

    let abs: string | null = null;
    if (pathArg) {
      abs = resolveRepoPath(pathArg, env);
      if (!isDirectory(abs)) {
        console.error(`not a directory: ${abs}`);
        return 1;
      }
    } else {
      abs = await pickDirectoryPath({
        message: `Folder for repo "${key}"`,
        startDir:
          repos[key] && isDirectory(repos[key]!)
            ? repos[key]
            : homeDir(env),
        env,
      });
      if (!abs) {
        p.cancel("Cancelled.");
        return 0;
      }
    }

    repos[key] = abs;
    saveRepos(configPath, repos);
    p.outro(`${key} → ${abs}`);
    return 0;
  }

  console.error(`Unknown repo subcommand: ${sub}`);
  console.error(repoCliHelp());
  return 2;
}
