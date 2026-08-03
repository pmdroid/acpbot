/**
 * Interactive directory browser for setup / repo CLI (clack TUI).
 */
import * as p from "@clack/prompts";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export type ListDirEntry = {
  name: string;
  path: string;
  /** true if directory */
  isDir: boolean;
};

export type ListSubdirsOptions = {
  /** Include dot-directories (default false). Always excludes `.` and `..`. */
  includeHidden?: boolean;
  /** Max entries (default 80). Excess still browseable via Type path. */
  limit?: number;
};

/** List immediate subdirectories (sorted, non-hidden by default). */
export function listSubdirectories(
  dir: string,
  options: ListSubdirsOptions = {},
): ListDirEntry[] {
  const includeHidden = options.includeHidden === true;
  const limit = options.limit ?? 80;
  const abs = resolve(dir);
  if (!existsSync(abs)) return [];
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [];

  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return [];
  }

  const out: ListDirEntry[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name === "." || name === "..") continue;
    if (!includeHidden && name.startsWith(".")) continue;
    const full = join(abs, name);
    try {
      if (statSync(full).isDirectory()) {
        out.push({ name, path: full, isDir: true });
      }
    } catch {
      /* permission / race */
    }
    if (out.length >= limit) break;
  }
  return out;
}

export function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function cancelled(v: unknown): boolean {
  return p.isCancel(v);
}

export type BrowseFolderOptions = {
  /** Starting directory (default: cwd or home). */
  startDir?: string;
  /** Prompt title. */
  message?: string;
  /** Prefer this path if it exists when opening. */
  initialPath?: string;
  /** Env for tests — unused today; reserved. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Folder browser: navigate with select, confirm path, or type absolute path.
 * Returns absolute path, or `null` if cancelled / aborted.
 */
export async function browseFolder(
  options: BrowseFolderOptions = {},
): Promise<string | null> {
  const home = options.env?.HOME?.trim() || homedir();
  let current = resolve(
    options.initialPath && isDirectory(options.initialPath)
      ? options.initialPath
      : options.startDir && isDirectory(options.startDir)
        ? options.startDir
        : process.cwd() && isDirectory(process.cwd())
          ? process.cwd()
          : home,
  );

  const title = options.message ?? "Choose a folder";

  for (;;) {
    const parent = dirname(current);
    const kids = listSubdirectories(current);
    const optionsList: Array<{
      value: string;
      label: string;
      hint?: string;
    }> = [
      {
        value: "__use__",
        label: `Use this folder`,
        hint: current,
      },
    ];

    if (parent !== current) {
      optionsList.push({
        value: "__up__",
        label: `.. (parent)`,
        hint: parent,
      });
    }

    optionsList.push({
      value: "__home__",
      label: `Home (${basename(home) || home})`,
      hint: home,
    });

    for (const d of kids) {
      optionsList.push({
        value: d.path,
        label: `${d.name}/`,
        hint: d.path,
      });
    }

    if (kids.length === 0) {
      optionsList.push({
        value: "__empty__",
        label: "(no subfolders)",
        hint: "use this folder, go up, or type a path",
      });
    }

    optionsList.push({
      value: "__type__",
      label: "Type path…",
      hint: "Absolute or ~/…",
    });
    optionsList.push({
      value: "__cancel__",
      label: "Cancel",
    });

    const pick = await p.select({
      message: `${title}\n  ${current}`,
      options: optionsList,
      initialValue: "__use__",
    });
    if (cancelled(pick)) return null;

    const v = String(pick);
    if (v === "__cancel__" || v === "__empty__") {
      if (v === "__cancel__") return null;
      continue;
    }
    if (v === "__use__") return current;
    if (v === "__up__") {
      current = parent;
      continue;
    }
    if (v === "__home__") {
      current = resolve(home);
      continue;
    }
    if (v === "__type__") {
      const typed = await p.text({
        message: "Folder path",
        // Current browse dir as placeholder only — empty field to type into
        placeholder: current,
        validate: (raw) => {
          const t = expandTilde(String(raw ?? "").trim(), home);
          if (!t) return "Required";
          if (!isDirectory(t)) return "Not a directory (or not found)";
          return undefined;
        },
      });
      if (cancelled(typed)) return null;
      return resolve(expandTilde(String(typed).trim(), home));
    }
    // Enter subdirectory
    if (isDirectory(v)) {
      current = resolve(v);
      continue;
    }
    p.log.warn(`Not a directory: ${v}`);
  }
}

export function expandTilde(path: string, home: string = homedir()): string {
  const t = path.trim();
  if (t === "~") return home;
  if (t.startsWith("~/") || t.startsWith("~\\")) {
    return join(home, t.slice(2));
  }
  return t;
}

/**
 * Ask for a path: browse interactively or type.
 * Returns absolute path or null if cancelled.
 */
export async function pickDirectoryPath(options: {
  message?: string;
  initialPath?: string;
  startDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const mode = await p.select({
    message: options.message ?? "How do you want to pick the folder?",
    options: [
      {
        value: "browse",
        label: "Browse folders…",
        hint: "Navigate with arrow keys",
      },
      {
        value: "type",
        label: "Type path…",
        hint: "Absolute or ~/…",
      },
      { value: "cancel", label: "Cancel" },
    ],
    initialValue: "browse",
  });
  if (cancelled(mode) || mode === "cancel") return null;

  if (mode === "type") {
    const home = options.env?.HOME?.trim() || homedir();
    const typed = await p.text({
      message: "Folder path",
      // Hint only — never prefill a guessed path
      placeholder: options.initialPath ?? "~/code/my-repo",
      validate: (raw) => {
        const t = expandTilde(String(raw ?? "").trim(), home);
        if (!t) return "Required";
        if (!isDirectory(t)) return "Not a directory (or not found)";
        return undefined;
      },
    });
    if (cancelled(typed)) return null;
    return resolve(expandTilde(String(typed).trim(), home));
  }

  return browseFolder({
    message: options.message ?? "Choose folder",
    startDir: options.startDir,
    initialPath: options.initialPath,
    env: options.env,
  });
}
