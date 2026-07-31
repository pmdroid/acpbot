/**
 * Single registry for operator slash commands.
 * Lobby (root chat) vs topic (session) scopes are explicit.
 */

export type CommandScope = "lobby" | "topic";

export type CommandDef = {
  /** Canonical name including leading slash, lowercase. */
  name: string;
  /** Extra names that map to the same command (also with slash). */
  aliases?: string[];
  scope: CommandScope | "both";
  /** One-line help. */
  summary: string;
};

/** Canonical operator surface — keep this list short. */
export const COMMANDS: readonly CommandDef[] = [
  {
    name: "/ping",
    scope: "lobby",
    summary: "Liveness check → pong",
  },
  {
    name: "/new",
    scope: "lobby",
    summary: "Create a session (picker, or /new <repo> <name>)",
  },
  {
    name: "/sessions",
    scope: "lobby",
    summary: "List sessions from tacp’s store",
  },
  {
    name: "/cancel",
    scope: "topic",
    summary: "Stop the current turn (keeps the session)",
  },
  {
    name: "/skills",
    scope: "topic",
    summary: "Pick a skill, then send a prompt to the agent",
  },
  {
    name: "/mode",
    scope: "topic",
    summary: "Show/toggle session mode (plan ↔ build), or /mode <id>",
  },
  {
    name: "/plan",
    scope: "topic",
    summary: "Switch agent to plan mode (read-only-ish)",
  },
  {
    name: "/build",
    scope: "topic",
    summary: "Switch agent to build/code mode (tools on)",
  },
  {
    name: "/mcp",
    scope: "topic",
    summary:
      "MCP gateways: status|add|remove|auth|code (tokens on host, not in repo)",
  },
  {
    name: "/help",
    scope: "both",
    summary: "Show commands for this surface",
  },
] as const;

export type ParsedSlash = {
  /** Canonical command name, e.g. /sessions */
  name: string;
  /** Arguments after the command token */
  args: string[];
  raw: string;
};

/** Normalize "/Sessions@bot" → "/sessions". */
export function normalizeCommandToken(token: string): string {
  let t = token.trim();
  // Strip @BotName suffix Telegram sometimes adds for slash commands.
  const at = t.indexOf("@");
  if (at > 0) t = t.slice(0, at);
  return t.toLowerCase();
}

export function resolveCanonicalName(token: string): string | undefined {
  const n = normalizeCommandToken(token);
  for (const cmd of COMMANDS) {
    if (cmd.name === n) return cmd.name;
    if (cmd.aliases?.some((a) => a === n)) return cmd.name;
  }
  // Legacy alias kept only as resolution, not advertised in help.
  if (n === "/list") return "/sessions";
  return undefined;
}

/**
 * Parse a message as a slash command, or null if it is not one.
 */
export function parseSlashCommand(text: string): ParsedSlash | null {
  const raw = text.trim();
  if (!raw.startsWith("/")) return null;
  const [tok, ...rest] = raw.split(/\s+/);
  if (!tok) return null;
  const name = resolveCanonicalName(tok);
  if (!name) {
    return {
      name: normalizeCommandToken(tok),
      args: rest,
      raw,
    };
  }
  return { name, args: rest, raw };
}

export function isKnownCommand(name: string): boolean {
  return COMMANDS.some((c) => c.name === name) || name === "/list";
}

export function commandAllowedIn(
  name: string,
  scope: CommandScope,
): boolean {
  const def = COMMANDS.find((c) => c.name === name);
  if (!def) return false;
  return def.scope === "both" || def.scope === scope;
}

export function lobbyHelpText(): string {
  const lines = [
    "tacp lobby — commands only (no agent output here).",
    "",
    ...COMMANDS.filter((c) => c.scope === "lobby" || c.scope === "both").map(
      (c) => `${c.name} — ${c.summary}`,
    ),
    "",
    "In a session topic: type to prompt the agent; use topic /help for session commands.",
  ];
  return lines.join("\n");
}

export function topicHelpText(): string {
  return [
    "Session topic — messages go to the agent.",
    "",
    ...COMMANDS.filter((c) => c.scope === "topic" || c.scope === "both").map(
      (c) => `${c.name} — ${c.summary}`,
    ),
    "",
    "Lobby commands (/new, /sessions, /ping) only work in the main chat.",
  ].join("\n");
}

export function wrongScopeMessage(
  name: string,
  scope: CommandScope,
): string {
  if (scope === "topic") {
    return `${name} is a lobby command — open the main chat with the bot (not a topic).`;
  }
  return `${name} only works inside a session topic.`;
}

export function unknownCommandMessage(scope: CommandScope): string {
  return scope === "lobby"
    ? "Unknown command. Try /help."
    : "Unknown command in this topic. Try /help (or open the lobby for /new, /sessions).";
}

// ── Telegram slash menu (setMyCommands) ─────────────────────────────────────

/** Bot API BotCommand — no leading slash; description ≤ 256 chars. */
export type TelegramMenuCommand = {
  command: string;
  description: string;
};

/**
 * Flat menu for Telegram “/” UI.
 *
 * Telegram cannot scope BotCommands per forum topic, so we register **all**
 * commands (lobby + topic). Operators see `/mcp`, `/mode`, `/skills`, etc. in
 * the autocomplete. Wrong-scope use still gets a clear error from the daemon
 * (e.g. `/mcp` only works inside a session topic).
 */
export function telegramMenuCommands(
  defs: readonly CommandDef[] = COMMANDS,
): TelegramMenuCommand[] {
  return defs.map((c) => ({
    command: c.name.replace(/^\//, "").toLowerCase(),
    description: c.summary.slice(0, 256),
  }));
}

export function menuFingerprint(commands: TelegramMenuCommand[]): string {
  return commands.map((c) => `${c.command}\0${c.description}`).join("\n");
}
