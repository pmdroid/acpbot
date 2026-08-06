/**
 * The single edge port. Nothing inside the daemon core is mocked in tests —
 * tests drive the real core over a fake Environment and assert on outbound
 * Telegram calls.
 */

// ── Config (no local-path / TTY / cached-credential assumptions) ────────────

/** Tool-permission policy (not session plan/build mode). */
export type PermissionMode = "ask" | "bypass";

/** Runtime config for the acpbot worker / host. */
export type AcpbotConfig = {
  /** Paired Telegram user id (from state_dir pairing; 0 = unpaired). Every other sender is ignored. */
  operatorUserId: number;
  /**
   * Optional chat id of the operator's private chat with the bot.
   * When set, outbound session messages are constrained to this chat.
   * Derived from the first operator message if omitted.
   */
  operatorChatId?: number;
  /**
   * Named repos available for session creation. Values are absolute working
   * directories supplied by configuration — never discovered from the host.
   */
  repos?: Record<string, string>;
  /** Default agent adapter name (e.g. "codex"). */
  defaultAgent?: string;
  /**
   * Default tool-permission policy for **new** sessions.
   * - ask (default): Telegram keyboard for each permission
   * - bypass: auto-allow (Grok yoloMode / spawn --always-approve)
   */
  permissionMode?: PermissionMode;
  /**
   * Extra skill roots (absolute dirs of skill collections or single skills).
   * Session cwd skill subdirs are always scanned in addition.
   */
  skillRoots?: string[];
  /**
   * When true, send image/audio as ACP prompt content blocks.
   * Requires agent `promptCapabilities.image` / `.audio` (Grok Build ACP
   * currently does not advertise these — leave false).
   */
  acpMediaAttachments?: boolean;
  /**
   * TTS policy:
   * - agent (default): only when the model calls the MCP speak tool
   * - always: every text reply
   * - off: never
   */
  ttsMode?: "off" | "always" | "agent";
  /**
   * When false, do not inject acpbot host MCP servers (speak, …) into ACP sessions.
   * Default true. Env: ACPBOT_MCP=0.
   */
  mcpEnabled?: boolean;
  /**
   * Multi-host catalog (parsed from [hosts] / structured [repos]).
   * When omitted, worker uses local Unix acp-host only.
   */
  hostsCatalog?: import("../acp-host/hosts").HostsCatalog;
  /** Multi-agent spawn caps / idle reclaim ([agents.spawn]). */
  agentSpawn?: {
    maxChildrenPerParent?: number;
    maxDepth?: number;
    maxConcurrentSpawned?: number;
    removeWorktreeOnKill?: boolean;
    deleteBranchOnKill?: boolean;
    /** Soft-close idle children after N hours (0 = off). Default 24. */
    idleCloseHours?: number;
  };
};


// ── Telegram shapes (subset of Bot API we use) ─────────────────────────────

export type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
};

export type TelegramChat = {
  id: number;
  type: string;
};

export type TelegramFileRef = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  /** photos only — width/height */
  width?: number;
  height?: number;
  /** documents / audio / video */
  file_name?: string;
  mime_type?: string;
  duration?: number;
};

export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  /** Caption for media messages */
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: TelegramMessage;
  photo?: TelegramFileRef[];
  document?: TelegramFileRef;
  voice?: TelegramFileRef;
  audio?: TelegramFileRef;
  video?: TelegramFileRef;
  video_note?: TelegramFileRef;
  sticker?: TelegramFileRef & { emoji?: string };
};

export type CallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
  chat_instance?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: CallbackQuery;
};

export type BotMe = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  /** Bot API 9.3+: topics enabled in private chats with this bot. */
  has_topics_enabled?: boolean;
};

export type SendMessageParams = {
  chatId: number;
  text: string;
  messageThreadId?: number;
  replyMarkup?: unknown;
  replyToMessageId?: number;
  parseMode?: string;
};

/** Telegram sendChatAction (typing / upload indicators; optional utility). */
export type SendChatActionParams = {
  chatId: number;
  /** e.g. "typing", "upload_photo", "upload_document", "record_voice" */
  action: string;
  messageThreadId?: number;
};

export type SendVoiceParams = {
  chatId: number;
  /** Raw OGG/Opus (or other) bytes */
  data: Uint8Array;
  filename?: string;
  messageThreadId?: number;
  caption?: string;
  replyToMessageId?: number;
};

export type SendDocumentParams = {
  chatId: number;
  data: Uint8Array;
  filename: string;
  messageThreadId?: number;
  caption?: string;
};

export type SendPhotoParams = {
  chatId: number;
  data: Uint8Array;
  filename?: string;
  messageThreadId?: number;
  caption?: string;
};

export type TelegramFileInfo = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  /** Path relative to Telegram file endpoint, or absolute local path on local Bot API */
  file_path?: string;
};

export type EditMessageTextParams = {
  chatId: number;
  messageId: number;
  text: string;
  replyMarkup?: unknown;
  parseMode?: string;
};

export type DeleteMessageParams = {
  chatId: number;
  messageId: number;
};

export type EditForumTopicParams = {
  chatId: number;
  messageThreadId: number;
  name?: string;
  iconCustomEmojiId?: string;
};

export type CreateForumTopicParams = {
  chatId: number;
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
};

export type ForumTopic = {
  message_thread_id: number;
  name: string;
  icon_color?: number;
};

export type AnswerCallbackQueryParams = {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
};

export type GetUpdatesParams = {
  offset?: number;
  timeout?: number;
  limit?: number;
  allowedUpdates?: string[];
};

/** Telegram BotCommand (slash menu entry). */
export type TelegramBotCommand = {
  command: string;
  description: string;
};

export type SetMyCommandsParams = {
  commands: TelegramBotCommand[];
  /** BotCommandScope object, e.g. { type: "all_private_chats" }. */
  scope?: Record<string, unknown>;
  languageCode?: string;
};

export type DeleteMyCommandsParams = {
  scope?: Record<string, unknown>;
  languageCode?: string;
};

export type GetMyCommandsParams = {
  scope?: Record<string, unknown>;
  languageCode?: string;
};

/** Telegram API error, including 409 conflict on concurrent getUpdates. */
export class TelegramApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export interface TelegramPort {
  getMe(): Promise<BotMe>;
  getUpdates(params: GetUpdatesParams): Promise<TelegramUpdate[]>;
  sendMessage(params: SendMessageParams): Promise<{ message_id: number }>;
  editMessageText(params: EditMessageTextParams): Promise<void>;
  deleteMessage(params: DeleteMessageParams): Promise<void>;
  editForumTopic(params: EditForumTopicParams): Promise<void>;
  createForumTopic(params: CreateForumTopicParams): Promise<ForumTopic>;
  answerCallbackQuery(params: AnswerCallbackQueryParams): Promise<void>;
  /**
   * Show a chat action (typing, upload, …). Telegram expires these ~5s;
   * callers should refresh while work is in progress.
   */
  sendChatAction(params: SendChatActionParams): Promise<void>;
  /** Resolve file_id → path for download */
  getFile?(fileId: string): Promise<TelegramFileInfo>;
  /** Download file bytes by file_id (uses getFile + fetch under the hood). */
  downloadFile?(fileId: string): Promise<Uint8Array>;
  sendVoice?(params: SendVoiceParams): Promise<{ message_id: number }>;
  sendDocument?(params: SendDocumentParams): Promise<{ message_id: number }>;
  sendPhoto?(params: SendPhotoParams): Promise<{ message_id: number }>;
  /** Register slash menu; optional on fakes that never hit Telegram. */
  setMyCommands?(params: SetMyCommandsParams): Promise<void>;
  deleteMyCommands?(params?: DeleteMyCommandsParams): Promise<void>;
  getMyCommands?(params?: GetMyCommandsParams): Promise<TelegramBotCommand[]>;
}

/** Optional speech services (STT / TTS). Absent → media still works without speech. */
export type SpeechPort = {
  /** Transcribe voice/audio bytes → text */
  stt?(
    audio: Uint8Array,
    opts: { mimeType: string; filename?: string },
  ): Promise<string>;
  /** Synthesize speech from text → audio bytes (prefer OGG/Opus for Telegram voice) */
  tts?(
    text: string,
    opts?: { voice?: string },
  ): Promise<{ data: Uint8Array; mimeType: string; filename: string }>;
};

// ── Agents (stub-shaped in ticket 01; filled in ticket 03) ─────────────────

export type SessionIdentity = {
  /** Repo key from config (not a filesystem path). */
  repo: string;
  /** Workstream name; several per repo is normal. */
  name: string;
  agent?: string;
};

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting-on-you"
  | "done"
  | "failed";

export type AgentSessionHandle = {
  sessionKey: string;
  identity: SessionIdentity;
  /** Explicit working directory from configuration. */
  cwd: string;
};

/** Binary attachment for ACP prompt (image/* or audio/* base64). */
export type PromptAttachment = {
  mediaType: string;
  /** Base64 without data: URL prefix */
  data: string;
  /** Optional original filename for logging */
  filename?: string;
};

export type PromptTurnInput = {
  text: string;
  /** image/* and audio/* forwarded as ACP content blocks */
  attachments?: PromptAttachment[];
  /** Must never be set — omission avoids artificial turn timeouts. */
  timeoutMs?: never;
  signal?: AbortSignal;
  mode?: "prompt" | "steer";
};

export type AcpTurnEvent =
  | { type: "turn_started" }
  | { type: "agent_message_chunk"; text: string }
  | {
      type: "tool_call";
      toolCallId: string;
      title?: string | undefined;
      /** Tool input when available (used for speak/tts detection). */
      rawInput?: unknown;
    }
  | { type: "tool_call_update"; toolCallId: string; status?: string }
  | { type: "permission_raised"; toolCallId: string }
  | { type: "permission_settled"; toolCallId: string }
  | { type: "turn_ended"; stopReason?: string }
  | { type: "process_died"; error?: string };

export type PromptTurn = {
  events: AsyncIterable<AcpTurnEvent>;
  done: Promise<{ stopReason?: string }>;
};

export type PermissionDecision =
  | { outcome: "allow_once" }
  | { outcome: "allow_always" }
  | { outcome: "reject_once" }
  | { outcome: "reject_always" }
  | { outcome: "cancel" };

export type PermissionRequest = {
  sessionId: string;
  toolCallId: string;
  raw: unknown;
};

export type ElicitationRequest = {
  sessionId: string;
  raw: unknown;
};

export type ElicitationDecision =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

export interface AgentsPort {
  /**
   * Create (or ensure) an ACP session for the given identity.
   * Optional permissionMode: bypass → host auto-allows + Grok yoloMode.
   */
  ensureSession(
    identity: SessionIdentity,
    opts?: {
      permissionMode?: PermissionMode;
      /** Rebuild agent + MCP (after OAuth / token change). */
      forceRespawn?: boolean;
      /**
       * Brand-new ACP conversation (session/new, no history resume).
       * Used by topic `/fresh`.
       */
      forceNewSession?: boolean;
      /**
       * Override working directory (multi-agent child worktree).
       * When set, used instead of config.repos[repo].
       */
      cwd?: string;
    },
  ): Promise<AgentSessionHandle>;

  /**
   * Run a prompt turn. timeoutMs must never be set on the underlying runtime.
   * Events are drained by a long-lived task in the core, never gated on Telegram.
   */
  runPromptTurn(
    handle: AgentSessionHandle,
    input: PromptTurnInput,
  ): Promise<PromptTurn>;

  /**
   * Cancel an in-flight turn for the session without destroying the session.
   */
  cancelTurn?(sessionKey: string, reason?: string): Promise<void>;

  /**
   * Kill host agent process for this slot (acp-host kill). Session may be
   * re-ensured later (soft-close / idle reclaim).
   */
  disposeSession?(sessionKey: string): Promise<void>;

  /**
   * Wire permission interception. Handler is awaited unbounded until the
   * operator answers (or the session turn is cancelled via ctx.signal).
   */
  setPermissionHandler?(
    handler: (
      req: PermissionRequest,
      ctx: { signal: AbortSignal },
    ) => Promise<PermissionDecision | undefined>,
  ): void;

  /**
   * Structured questions (elicitation/create). Rendered as multi-choice
   * Telegram buttons when options are present.
   */
  setElicitationHandler?(
    handler: (
      req: ElicitationRequest,
      ctx: { signal: AbortSignal },
    ) => Promise<ElicitationDecision | undefined>,
  ): void;

  /**
   * Grok Build multi-choice via `_x.ai/ask_user_question`.
   * Return value is the JSON result for the agent tool.
   */
  setAskUserQuestionHandler?(
    handler: (
      req: { sessionId: string; raw: unknown },
      ctx: { signal: AbortSignal },
    ) => Promise<Record<string, unknown>>,
  ): void;

  /**
   * ACP session/set_mode. Used by /plan, /build, /mode slash commands.
   */
  setSessionMode?(
    sessionKey: string,
    modeId: string,
  ): Promise<{ currentModeId?: string; availableModeIds: string[] }>;

  /** Current + available modes for a live session (empty if unknown). */
  getSessionMode?(
    sessionKey: string,
  ): Promise<{ currentModeId?: string; availableModeIds: string[] }>;

  /**
   * ACP session configOptions (model select, etc.).
   * Empty when the agent does not advertise options.
   */
  getSessionConfigOptions?(
    sessionKey: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      type: string;
      category?: string | null;
      currentValue?: string | boolean | null;
      options: Array<{ value: string; name?: string }>;
    }>
  >;

  /** ACP session/set_config_option (e.g. model value). */
  setSessionConfigOption?(
    sessionKey: string,
    configId: string,
    value: string | boolean,
  ): Promise<
    Array<{
      id: string;
      name: string;
      type: string;
      category?: string | null;
      currentValue?: string | boolean | null;
      options: Array<{ value: string; name?: string }>;
    }>
  >;

  /**
   * Switch agent binary for an existing session (respawn process).
   * Updates identity.agent and recreates the live ACP session.
   */
  switchSessionAgent?(
    identity: SessionIdentity,
    agentId: string,
  ): Promise<AgentSessionHandle>;
}

// ── Clock ──────────────────────────────────────────────────────────────────

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Sleep until duration elapses or signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

// ── Store ──────────────────────────────────────────────────────────────────

/**
 * Durable key/value store. Keys are opaque strings; values must be
 * JSON-serializable. Restart is modelled by a new core over the same store.
 */
export interface Store {
  load<T>(key: string): Promise<T | undefined>;
  save<T>(key: string, value: T): Promise<void>;
  delete?(key: string): Promise<void>;
  listKeys?(prefix?: string): Promise<string[]>;
}

// ── Logging ────────────────────────────────────────────────────────────────

export type { LogLevel, LogMeta, Logger } from "./logger";

// ── Composite environment ──────────────────────────────────────────────────

export type Environment = {
  config: AcpbotConfig;
  telegram: TelegramPort;
  agents: AgentsPort;
  clock: Clock;
  store: Store;
  /** Optional; defaults to silent in tests / createDaemon. */
  log?: import("./logger").Logger;
  /** Optional STT/TTS — wired when API keys / providers are configured. */
  speech?: SpeechPort;
};
