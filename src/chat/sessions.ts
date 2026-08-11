/**
 * CLI session registry: list / resolve / focus helpers for multi-session hub.
 * Focus is local to the chat process (not shared with Telegram worker).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ChatSessionRef = {
  sessionKey: string;
  agent: string;
  cwd: string;
  busy?: boolean;
  agentSessionId?: string | null;
  /** Optional leaf slug for display (after --). */
  slug?: string;
  role?: string;
  spawnStatus?: string;
};

export type FocusState = {
  focusKey: string | null;
  updatedAt: string;
};

export type HostSlotInfo = {
  slotKey: string;
  agent: string;
  cwd: string;
  busy: boolean;
  agentSessionId?: string | null;
};

/** Parse `repo/name` or `repo/name--child`. */
export function parseSessionKey(sessionKey: string): {
  repo: string;
  name: string;
  slug?: string;
} {
  const slash = sessionKey.indexOf("/");
  if (slash <= 0 || slash === sessionKey.length - 1) {
    throw new Error(
      `invalid session key "${sessionKey}" — expected repo/name`,
    );
  }
  const repo = sessionKey.slice(0, slash);
  const rest = sessionKey.slice(slash + 1);
  const dd = rest.indexOf("--");
  if (dd >= 0) {
    const slug = rest.slice(dd + 2);
    return {
      repo,
      name: rest.slice(0, dd) || "main",
      ...(slug ? { slug } : {}),
    };
  }
  return { repo, name: rest };
}

export function formatSessionKey(repo: string, name: string, slug?: string): string {
  const base = `${repo.trim()}/${name.trim() || "main"}`;
  if (!slug?.trim()) return base;
  return `${base}--${slug.trim()}`;
}

export function childSlugOf(sessionKey: string): string | undefined {
  try {
    return parseSessionKey(sessionKey).slug;
  } catch {
    return undefined;
  }
}

/**
 * Resolve focus token:
 * - full `repo/name`
 * - `#n` / `n` 1-based index into `listed`
 * - leaf slug match (unique)
 * - unique name substring
 */
export function resolveSessionRef(
  token: string,
  listed: ChatSessionRef[],
  opts?: { defaultRepo?: string },
): ChatSessionRef {
  const t = token.trim();
  if (!t) throw new Error("empty session selector");

  // index: #2 or 2
  const idxMatch = t.match(/^#?(\d+)$/);
  if (idxMatch) {
    const i = Number(idxMatch[1]) - 1;
    if (i < 0 || i >= listed.length) {
      throw new Error(
        `no session at index ${idxMatch[1]} (have ${listed.length})`,
      );
    }
    return listed[i]!;
  }

  // full key
  if (t.includes("/")) {
    const hit = listed.find((s) => s.sessionKey === t);
    if (hit) return hit;
    // allow ensure of unknown key if well-formed
    const parsed = parseSessionKey(t);
    return {
      sessionKey: t,
      agent: "",
      cwd: "",
      ...(parsed.slug ? { slug: parsed.slug } : {}),
    };
  }

  // unique slug
  const bySlug = listed.filter(
    (s) => (s.slug ?? childSlugOf(s.sessionKey)) === t,
  );
  if (bySlug.length === 1) return bySlug[0]!;
  if (bySlug.length > 1) {
    throw new Error(
      `ambiguous slug "${t}" — matches ${bySlug.map((s) => s.sessionKey).join(", ")}`,
    );
  }

  // unique name (leaf of key)
  const byName = listed.filter((s) => {
    try {
      const p = parseSessionKey(s.sessionKey);
      return p.name === t || s.sessionKey.endsWith(`/${t}`);
    } catch {
      return false;
    }
  });
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(
      `ambiguous name "${t}" — matches ${byName.map((s) => s.sessionKey).join(", ")}`,
    );
  }

  // defaultRepo/name
  if (opts?.defaultRepo) {
    const key = formatSessionKey(opts.defaultRepo, t);
    const hit = listed.find((s) => s.sessionKey === key);
    if (hit) return hit;
    return { sessionKey: key, agent: "", cwd: "" };
  }

  throw new Error(`unknown session "${t}" — try /sessions`);
}

export function slotsToRefs(slots: HostSlotInfo[]): ChatSessionRef[] {
  return slots.map((s) => {
    const slug = childSlugOf(s.slotKey);
    return {
      sessionKey: s.slotKey,
      agent: s.agent,
      cwd: s.cwd,
      busy: s.busy,
      agentSessionId: s.agentSessionId ?? null,
      ...(slug ? { slug } : {}),
    };
  });
}

/** Merge host live slots with durable session store records. */
export function mergeSessionLists(
  live: ChatSessionRef[],
  durable: Array<{ sessionKey: string; agent: string; cwd: string }>,
): ChatSessionRef[] {
  const map = new Map<string, ChatSessionRef>();
  for (const d of durable) {
    const slug = childSlugOf(d.sessionKey);
    map.set(d.sessionKey, {
      sessionKey: d.sessionKey,
      agent: d.agent,
      cwd: d.cwd,
      busy: false,
      ...(slug ? { slug } : {}),
    });
  }
  for (const l of live) {
    map.set(l.sessionKey, { ...map.get(l.sessionKey), ...l });
  }
  return [...map.values()].sort((a, b) =>
    a.sessionKey.localeCompare(b.sessionKey),
  );
}

export function formatSessionTree(
  sessions: ChatSessionRef[],
  focusKey: string | null,
  opts?: {
    /** Spawn registry children keyed by parent sessionKey. */
    childrenByParent?: Record<
      string,
      Array<{ sessionKey: string; agent?: string; status?: string; role?: string }>
    >;
  },
): string {
  if (sessions.length === 0) return "(no sessions)";
  const lines: string[] = [];
  const listed = new Set<string>();
  let n = 0;
  const emit = (
    s: ChatSessionRef,
    indent: string,
  ) => {
    n += 1;
    listed.add(s.sessionKey);
    const mark = s.sessionKey === focusKey ? "*" : " ";
    const busy = s.busy ? " busy" : "";
    const agent = s.agent ? ` [${s.agent}]` : "";
    const role = s.role ? ` (${s.role})` : "";
    const status = s.spawnStatus ? ` {${s.spawnStatus}}` : "";
    lines.push(
      `${mark}${n}. ${indent}${s.sessionKey}${agent}${role}${status}${busy}`,
    );
    const kids = opts?.childrenByParent?.[s.sessionKey] ?? [];
    for (const k of kids) {
      if (listed.has(k.sessionKey)) continue;
      emit(
        {
          sessionKey: k.sessionKey,
          agent: k.agent ?? "",
          cwd: "",
          slug: childSlugOf(k.sessionKey),
          ...(k.role ? { role: k.role } : {}),
          ...(k.status ? { spawnStatus: k.status } : {}),
        },
        `${indent}  `,
      );
    }
  };

  // Roots first (no -- in key), then orphans
  const roots = sessions.filter((s) => !s.sessionKey.includes("--"));
  const rest = sessions.filter((s) => s.sessionKey.includes("--"));
  for (const s of roots) emit(s, "");
  for (const s of rest) {
    if (!listed.has(s.sessionKey)) emit(s, "");
  }
  return lines.join("\n");
}

export function focusStatePath(stateDir: string): string {
  return join(stateDir, "chat-focus.json");
}

export async function loadFocus(stateDir: string): Promise<FocusState> {
  try {
    const raw = await readFile(focusStatePath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as FocusState;
    if (parsed && typeof parsed === "object") {
      return {
        focusKey:
          typeof parsed.focusKey === "string" ? parsed.focusKey : null,
        updatedAt:
          typeof parsed.updatedAt === "string"
            ? parsed.updatedAt
            : new Date().toISOString(),
      };
    }
  } catch {
    /* missing */
  }
  return { focusKey: null, updatedAt: new Date().toISOString() };
}

export async function saveFocus(
  stateDir: string,
  focusKey: string | null,
): Promise<FocusState> {
  const state: FocusState = {
    focusKey,
    updatedAt: new Date().toISOString(),
  };
  const path = focusStatePath(stateDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}
