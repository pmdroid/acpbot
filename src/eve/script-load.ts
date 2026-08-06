/**
 * Load EVE directive scripts from project / user / bundled locations.
 */
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoConfigDir } from "../env/repo-config-dir";
import type { EveMeta } from "./types";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function assertSafeEveName(name: string): string {
  const n = name.trim().replace(/\.js$/i, "");
  if (!NAME_RE.test(n)) {
    throw new Error(
      `invalid EVE directive name: ${name} (use [a-z0-9_-], max 64)`,
    );
  }
  return n.toLowerCase();
}

export function projectEveDir(repoRoot: string): string {
  return join(resolveRepoConfigDir(repoRoot), "eve");
}

export function userEveDir(stateDir: string): string {
  return join(stateDir, "eve", "directives");
}

export function bundledEveDir(): string {
  // src/eve/bundled next to this file (works for source; compile may embed)
  return join(dirname(fileURLToPath(import.meta.url)), "bundled");
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  if (c === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(prefix);
}

/**
 * Extract pure-literal `export const meta = { ... }` for approval UI.
 * Brace-balanced so nested phases: [...] works.
 */
export function extractEveMeta(source: string): EveMeta {
  // Strip block comments lightly
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const start = cleaned.search(/export\s+const\s+meta\s*=\s*\{/);
  if (start < 0) {
    throw new Error(
      "EVE script must export const meta = { name, description, ... } as a pure literal",
    );
  }
  const braceStart = cleaned.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    throw new Error("EVE meta object is not brace-balanced");
  }
  const lit = cleaned.slice(braceStart, end + 1);
  let obj: unknown;
  try {
    // eslint-disable-next-line no-new-func
    obj = new Function(`"use strict"; return (${lit})`)();
  } catch (err) {
    throw new Error(
      `could not parse EVE meta: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("EVE meta must be an object");
  }
  const rec = obj as Record<string, unknown>;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  const description =
    typeof rec.description === "string" ? rec.description.trim() : "";
  if (!name || !description) {
    throw new Error("EVE meta requires name and description strings");
  }
  const phases: { title: string }[] = [];
  if (Array.isArray(rec.phases)) {
    for (const p of rec.phases) {
      if (p && typeof p === "object" && typeof (p as { title?: unknown }).title === "string") {
        phases.push({ title: String((p as { title: string }).title) });
      }
    }
  }
  return {
    name: assertSafeEveName(name),
    description,
    ...(phases.length ? { phases } : {}),
  };
}

/**
 * Body to execute: strip export meta / export default wrapping for AsyncFunction.
 */
export function extractEveBody(source: string): string {
  let body = source;
  // Strip meta with brace balance (same as extractEveMeta)
  const start = body.search(/export\s+const\s+meta\s*=\s*\{/);
  if (start >= 0) {
    const braceStart = body.indexOf("{", start);
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end >= 0) {
      let cutEnd = end + 1;
      if (body[cutEnd] === ";") cutEnd++;
      body = body.slice(0, start) + body.slice(cutEnd);
    }
  }
  body = body.trim();

  // export default async function (...) { ... }
  const defFn = body.match(
    /export\s+default\s+async\s+function\s*(?:\w*)\s*\([^)]*\)\s*\{([\s\S]*)\}\s*;?\s*$/,
  );
  if (defFn?.[1]) {
    return defFn[1];
  }

  // export default async (...) => { ... }
  const arrow = body.match(
    /export\s+default\s+async\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>\s*\{([\s\S]*)\}\s*;?\s*$/,
  );
  if (arrow?.[1]) {
    return arrow[1];
  }

  // Bare top-level await script (no export default)
  body = body.replace(/^export\s+default\s+/m, "");
  // Drop any remaining export keywords that would break AsyncFunction
  body = body.replace(/^export\s+/gm, "");
  return body;
}

export type ResolvedEveScript = {
  name: string;
  path: string;
  source: string;
  meta: EveMeta;
  origin: "project" | "user" | "bundled" | "ephemeral";
};

export async function resolveEveScript(input: {
  name?: string;
  path?: string;
  source?: string;
  repoRoot: string;
  stateDir: string;
}): Promise<ResolvedEveScript> {
  if (input.source?.trim()) {
    const meta = extractEveMeta(input.source);
    return {
      name: meta.name,
      path: "(inline)",
      source: input.source,
      meta,
      origin: "ephemeral",
    };
  }

  if (input.path?.trim()) {
    const abs = await resolveWritableScriptPath(
      input.repoRoot,
      input.stateDir,
      input.path,
      "read",
    );
    const source = await readFile(abs, "utf8");
    const meta = extractEveMeta(source);
    return {
      name: meta.name,
      path: abs,
      source,
      meta,
      origin: abs.includes(`${sep}bundled${sep}`) ? "bundled" : "project",
    };
  }

  const name = assertSafeEveName(input.name ?? "");
  const candidates: { path: string; origin: ResolvedEveScript["origin"] }[] = [
    { path: join(projectEveDir(input.repoRoot), `${name}.js`), origin: "project" },
    { path: join(userEveDir(input.stateDir), `${name}.js`), origin: "user" },
    { path: join(bundledEveDir(), `${name}.js`), origin: "bundled" },
  ];

  for (const c of candidates) {
    try {
      await access(c.path, constants.R_OK);
      const source = await readFile(c.path, "utf8");
      const meta = extractEveMeta(source);
      return { name: meta.name, path: c.path, source, meta, origin: c.origin };
    } catch {
      // try next
    }
  }
  throw new Error(
    `EVE directive not found: ${name} (looked in .acpbot/eve/, user eve/directives, bundled)`,
  );
}

export async function listEveScripts(input: {
  repoRoot: string;
  stateDir: string;
}): Promise<
  { name: string; description: string; origin: string; path: string }[]
> {
  const out: {
    name: string;
    description: string;
    origin: string;
    path: string;
  }[] = [];
  const seen = new Set<string>();

  const scan = async (
    dir: string,
    origin: string,
  ): Promise<void> => {
    let names: string[];
    try {
      const { readdir } = await import("node:fs/promises");
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const f of names) {
      if (!f.endsWith(".js")) continue;
      const path = join(dir, f);
      try {
        const source = await readFile(path, "utf8");
        const meta = extractEveMeta(source);
        if (seen.has(meta.name)) continue;
        seen.add(meta.name);
        out.push({
          name: meta.name,
          description: meta.description,
          origin,
          path,
        });
      } catch {
        // skip invalid
      }
    }
  };

  await scan(projectEveDir(input.repoRoot), "project");
  await scan(userEveDir(input.stateDir), "user");
  await scan(bundledEveDir(), "bundled");
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeEveScript(input: {
  repoRoot: string;
  stateDir: string;
  name: string;
  source: string;
  scope?: "project" | "user";
}): Promise<{ path: string; meta: EveMeta }> {
  const meta = extractEveMeta(input.source);
  const name = assertSafeEveName(input.name || meta.name);
  if (meta.name !== name) {
    // allow name override only if meta matches after normalize
  }
  const scope = input.scope ?? "project";
  const dir =
    scope === "user"
      ? userEveDir(input.stateDir)
      : projectEveDir(input.repoRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.js`);
  // Refuse symlink targets
  try {
    const real = await realpath(path);
    if (real !== path && !isWithinRoot(dir, real)) {
      throw new Error("refusing to write through symlink outside eve dir");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      if (err instanceof Error && err.message.includes("symlink")) throw err;
    }
  }
  await writeFile(path, input.source.endsWith("\n") ? input.source : input.source + "\n", "utf8");
  return { path, meta: { ...meta, name } };
}

async function resolveWritableScriptPath(
  repoRoot: string,
  stateDir: string,
  rawPath: string,
  _mode: "read" | "write",
): Promise<string> {
  const raw = rawPath.trim();
  if (!raw || raw.includes("\0")) throw new Error("invalid script path");
  if (raw.includes("..")) throw new Error("script path must not contain ..");

  const abs = isAbsolute(raw) ? resolve(raw) : resolve(repoRoot, raw);
  const allowedRoots = [
    projectEveDir(repoRoot),
    userEveDir(stateDir),
    bundledEveDir(),
    join(stateDir, "eve", "runs"),
  ];
  let ok = false;
  for (const root of allowedRoots) {
    if (isWithinRoot(root, abs)) {
      ok = true;
      break;
    }
  }
  // Also allow relative under .acpbot/eve
  if (!ok && isWithinRoot(resolveRepoConfigDir(repoRoot), abs)) {
    ok = true;
  }
  if (!ok) {
    throw new Error(
      `script path not under allowed EVE dirs: ${relative(repoRoot, abs) || abs}`,
    );
  }
  return abs;
}

export async function freezeScriptForRun(input: {
  stateDir: string;
  runId: string;
  source: string;
}): Promise<string> {
  const dir = join(input.stateDir, "eve", "runs", input.runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "script.js");
  await writeFile(path, input.source.endsWith("\n") ? input.source : input.source + "\n", "utf8");
  return path;
}
