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
    summary: "Create a session (needs a repo from `acpbot repo`)",
  },
  {
    name: "/sessions",
    scope: "lobby",
    summary: "List sessions from acpbot’s store",
  },
  {
    name: "/cancel",
    scope: "topic",
    summary: "Stop the current turn and clear the prompt queue",
  },
  {
    name: "/fresh",
    aliases: ["/reset"],
    scope: "topic",
    summary: "Fresh agent session (clear history; keep topic) — like Grok new",
  },
  {
    name: "/steer",
    scope: "topic",
    summary:
      "Interrupt the current turn and send guidance now (/steer <text>)",
  },
  {
    name: "/queue",
    scope: "topic",
    summary: "List messages waiting until the current turn ends",
  },
  {
    name: "/unqueue",
    scope: "topic",
    summary: "Remove queued msgs: /unqueue | /unqueue <n> | /unqueue all",
  },
  {
    name: "/skills",
    scope: "topic",
    summary: "Pick a skill, then send a prompt to the agent",
  },
  {
    name: "/mode",
    scope: "topic",
    summary: "Pick session mode from a list, or /mode <id>|toggle",
  },
  {
    name: "/permissions",
    aliases: ["/permission", "/yolo"],
    scope: "both",
    summary:
      "Tool permissions: Ask/Bypass buttons, or ask|bypass / default ask|bypass",
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
    name: "/status",
    scope: "topic",
    summary: "Session context: agent, model, mode, cwd, MCP",
  },
  {
    name: "/model",
    scope: "topic",
    summary: "Pick LLM model (ACP config) or /model <value>",
  },
  {
    name: "/effort",
    scope: "topic",
    summary: "Pick reasoning effort, or /effort <level>",
  },
  {
    name: "/agent",
    scope: "topic",
    summary: "Switch agent process (respawn) or /agent <id>",
  },
  {
    name: "/review",
    scope: "topic",
    summary:
      "Two-agent closeout review: /review [local|branch] [a] [b] [panel|adversarial]",
  },
  {
    name: "/mcp",
    scope: "topic",
    summary:
      "MCP gateways: status|add|remove|auth|code (tokens on host, not in repo)",
  },
  {
    name: "/linear",
    scope: "topic",
    summary:
      "Linear: connect|project|export|next|work|fanout|drain (topic ↔ project)",
  },
  {
    name: "/eve",
    scope: "topic",
    summary:
      "EVE directives: run|approve|status|list|pause|resume|kill|answer (background multi-agent)",
    aliases: ["/directive"],
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
    "**Lobby** (commands only)",
    ...COMMANDS.filter((c) => c.scope === "lobby" || c.scope === "both").map(
      (c) => `${c.name} — ${c.summary}`,
    ),
    "",
    "Sessions need a workspace repo: `acpbot repo add`, then `/new`.",
    "Prompt the agent in a session topic · topic `/help` for more.",
  ];
  return lines.join("\n");
}

export function topicHelpText(): string {
  return [
    "**Topic** — messages go to the agent.",
    ...COMMANDS.filter((c) => c.scope === "topic" || c.scope === "both").map(
      (c) => `${c.name} — ${c.summary}`,
    ),
    "",
    "Busy turn: free-text **queues** · `/steer` interrupts · `/unqueue` removes.",
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
