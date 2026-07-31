import type {
  Environment,
  PermissionDecision,
  PermissionRequest,
  SessionIdentity,
  SessionStatus,
  TelegramMessage,
  TelegramUpdate,
} from "../env/types";
import { TelegramApiError } from "../env/types";
import { silentLogger, summarizeUpdate } from "../env/logger";
import {
  buildAskQuestionUi,
  createAskUserQuestionBroker,
  newAskToken,
  parseAskUserQuestions,
  toAskUserQuestionExtResponse,
  type AskUserQuestionBroker,
} from "./ask-user-question";
import {
  encodeModeCallback,
  encodeNewRepoCallback,
  keyboardFromButtons,
  newToken,
  parseAskQuestionCallback,
  parseElicitationCallback,
  parseModeCallback,
  parseNewRepoCallback,
  parsePermissionCallback,
  parseSkillCallback,
} from "./callbacks";
import {
  buildElicitationUi,
  createElicitationBroker,
  type ElicitationBroker,
} from "./elicitation";
import { chunkHtmlForTelegram, formatForTelegram } from "./markdown";
import {
  buildPermissionUi,
  createPermissionBroker,
  type PermissionBroker,
} from "./permissions";
import {
  emptySessionIndex,
  loadOperatorChatId,
  loadSessionIndex,
  loadUpdateOffset,
  saveOperatorChatId,
  saveSessionIndex,
  saveUpdateOffset,
  type PersistedSession,
  type SessionIndex,
} from "./persistence";
import {
  commandAllowedIn,
  isKnownCommand,
  lobbyHelpText,
  parseSlashCommand,
  topicHelpText,
  unknownCommandMessage,
  wrongScopeMessage,
} from "./commands";
import { syncTelegramSlashMenu } from "./menu-sync";
import {
  messageHasMedia,
  messageTextOrCaption,
  prepareAgentMedia,
  textForTts,
} from "./media";
import {
  extractSpeakFromReply,
  isSpeakToolName,
  speakTextFromToolInput,
  type SpeakRequest,
} from "./speak";
import {
  completeSpeakJob,
  listPendingSpeakJobs,
  speakQueueDir,
} from "../mcp/speak-queue";
import {
  completeTelegramJob,
  listPendingTelegramJobs,
  telegramQueueDir,
} from "../mcp/telegram-queue";
import { isTelegramTextToolName } from "./telegram-tools";
import {
  buildSkillsKeyboard,
  clampSkillPage,
  composeSkillAgentPrompt,
  formatSkillsList,
  listSkills,
  skillPageCount,
  skillRootsForSession,
  SKILL_CB,
  SKILL_PAGE_SIZE,
  type PendingSkillPick,
  type PendingSkillText,
  type SkillInfo,
} from "./skills";
import { initialTopicName, reduceStatus, topicName } from "./status";
import {
  formatModeStatus,
  formatSessionStatus,
  resolveBuildModeId,
  resolveModeToken,
  resolvePlanModeId,
  togglePlanBuildModeId,
} from "../acp/session-mode";
import { resolveAgentLaunch } from "../acp/agent-launch";
import {
  buildSessionMcpServers,
  formatMcpRegistryStatus,
  MCP_COMMAND_USAGE,
  readMcpConfig,
  removeMcpServer,
  writeRemoteMcpServer,
} from "../mcp/repo-mcp";
import {
  completeMcpOAuthFromPaste,
  startMcpOAuth,
} from "../mcp/oauth-flow";
import {
  listOAuthTokenIds,
  repoKeyForOAuth,
  resolveOAuthStateDir,
} from "../mcp/oauth-store";
import type { AcpTurnEvent, PromptAttachment } from "../env/types";

export type DaemonOptions = {
  pollTimeoutSec?: number;
  conflictBackoffMs?: number;
  /**
   * Absolute (or resolvable) acpx state dir — **must match acp-host**
   * `TACP_ACPX_STATE_DIR` so OAuth pending/tokens are shared across processes.
   */
  acpxStateDir?: string;
};

export type Daemon = {
  run(signal?: AbortSignal): Promise<void>;
  handleUpdate(update: TelegramUpdate): Promise<void>;
  listSessions(): Promise<PersistedSession[]>;
  createSession(identity: SessionIdentity): Promise<PersistedSession>;
};

export class TopicsDisabledError extends Error {
  constructor() {
    super(
      "Bot does not have topics enabled (getMe.has_topics_enabled is false). " +
        "Enable topic mode for this bot via @BotFather, then restart tacp.",
    );
    this.name = "TopicsDisabledError";
  }
}

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

const PING_REPLY = "pong";

type LobbyPendingName = {
  repo: string;
  chatId: number;
};

/**
 * Pure daemon core. Depends only on the injected Environment.
 */
export function createDaemon(
  env: Environment,
  options: DaemonOptions = {},
): Daemon {
  const pollTimeoutSec = options.pollTimeoutSec ?? 25;
  const conflictBackoffMs = options.conflictBackoffMs ?? 1000;
  const log = (env.log ?? silentLogger()).child("daemon");
  // Same absolute path worker + acp-host must share for OAuth pending/tokens.
  const acpxStateDir = resolveOAuthStateDir(options.acpxStateDir);

  let sessionIndex: SessionIndex = emptySessionIndex();
  let operatorChatId: number | undefined = env.config.operatorChatId;
  let started = false;
  let permissionWired = false;

  const drainTasks = new Map<string, Promise<void>>();
  const turnAbort = new Map<string, AbortController>();
  const permissions: PermissionBroker = createPermissionBroker();
  const elicitations: ElicitationBroker = createElicitationBroker();
  const askQuestions: AskUserQuestionBroker = createAskUserQuestionBroker();
  /** token → skill list while picker is open */
  const skillPicks = new Map<string, PendingSkillPick>();
  /** sessionKey → waiting for operator text after skill pick */
  const skillTextPending = new Map<string, PendingSkillText>();
  /** Mode picker: token → available modes for this session. */
  const modePicks = new Map<
    string,
    { sessionKey: string; modes: string[]; current?: string }
  >();
  /**
   * In-memory only — never persisted. Restart always exits naming mode.
   * While set, a valid one-word free-text creates a session topic; must be
   * cleared the instant a name is accepted or the operator cancels.
   */
  let pendingName: LobbyPendingName | undefined;

  let botUserId: number | undefined;

  function clearPendingNew(reason: string): boolean {
    if (!pendingName) return false;
    log.info("exit /new naming mode", {
      reason,
      repo: pendingName.repo,
    });
    pendingName = undefined;
    return true;
  }

  function enterPendingNew(repo: string, chatId: number): void {
    pendingName = { repo, chatId };
    log.info("enter /new naming mode", { repo, chatId });
  }

  /** Accept only short single-token names so casual chat cannot spawn topics. */
  function parseSessionNameCandidate(text: string): string | undefined {
    const t = text.trim();
    if (!t || /\s/.test(t)) return undefined;
    if (t.length > 48) return undefined;
    if (!/^[\w][\w.-]*$/.test(t)) return undefined;
    return t;
  }

  const isOperator = (userId: number | undefined): boolean =>
    userId !== undefined && userId === env.config.operatorUserId;

  const senderOf = (update: TelegramUpdate): number | undefined => {
    if (update.message?.from?.id !== undefined) return update.message.from.id;
    if (update.callback_query?.from?.id !== undefined) {
      return update.callback_query.from.id;
    }
    if (update.edited_message?.from?.id !== undefined) {
      return update.edited_message.from.id;
    }
    return undefined;
  };

  const isBotSelf = (update: TelegramUpdate): boolean => {
    const from =
      update.message?.from ??
      update.edited_message?.from ??
      update.callback_query?.from;
    if (!from) return false;
    if (from.is_bot === true) return true;
    if (botUserId !== undefined && from.id === botUserId) return true;
    return false;
  };

  const repoKeys = (): string[] => Object.keys(env.config.repos ?? {});

  async function assertTopicsEnabled(): Promise<void> {
    const me = await env.telegram.getMe();
    botUserId = me.id;
    log.info("bot identity", {
      id: me.id,
      username: me.username,
      has_topics_enabled: me.has_topics_enabled,
    });
    if (!me.has_topics_enabled) {
      throw new TopicsDisabledError();
    }
  }

  async function hydrate(): Promise<void> {
    sessionIndex = await loadSessionIndex(env.store);
    const storedChat = await loadOperatorChatId(env.store);
    if (storedChat !== undefined) operatorChatId = storedChat;
    if (env.config.operatorChatId !== undefined) {
      operatorChatId = env.config.operatorChatId;
    }
    // Naming mode is never durable — process start/restart always exits it.
    clearPendingNew("hydrate/restart");
    wirePermissionHandler();
  }

  async function persistIndex(): Promise<void> {
    await saveSessionIndex(env.store, sessionIndex);
  }

  async function ensureOperatorChat(chatId: number): Promise<void> {
    if (operatorChatId === undefined) {
      operatorChatId = chatId;
      await saveOperatorChatId(env.store, chatId);
    }
  }

  async function renameTopic(
    session: PersistedSession,
    status: SessionStatus,
  ): Promise<void> {
    const name = topicName(
      session.identity.repo,
      session.identity.name,
      status,
    );
    await env.telegram.editForumTopic({
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
      name,
    });
    session.status = status;
    session.updatedAt = env.clock.now();
    sessionIndex.byKey[session.sessionKey] = session;
    await persistIndex();
  }

  async function createSession(
    identity: SessionIdentity,
  ): Promise<PersistedSession> {
    if (operatorChatId === undefined) {
      throw new Error(
        "operator chat id unknown — send any message in the lobby first, or set operatorChatId in config",
      );
    }

    // Creating (or reusing) a session always ends naming mode.
    clearPendingNew("createSession");

    const sessionKey = `${identity.repo}/${identity.name}`;
    const existing = sessionIndex.byKey[sessionKey];
    if (existing) {
      log.info("session already exists — no new topic", { sessionKey });
      return existing;
    }

    const handle = await env.agents.ensureSession(identity);
    const topic = await env.telegram.createForumTopic({
      chatId: operatorChatId,
      name: initialTopicName(identity.repo, identity.name),
    });

    const now = env.clock.now();
    const record: PersistedSession = {
      sessionKey,
      identity: { ...identity },
      messageThreadId: topic.message_thread_id,
      chatId: operatorChatId,
      status: "idle",
      cwd: handle.cwd,
      createdAt: now,
      updatedAt: now,
    };

    sessionIndex.byKey[sessionKey] = record;
    sessionIndex.byThread[String(topic.message_thread_id)] = sessionKey;
    await persistIndex();
    log.info("session topic created", {
      sessionKey,
      thread: topic.message_thread_id,
    });
    return record;
  }

  async function listSessions(): Promise<PersistedSession[]> {
    return Object.values(sessionIndex.byKey);
  }

  async function replyInRoot(
    chatId: number,
    text: string,
    replyMarkup?: unknown,
    opts?: { html?: boolean; /** Echo into this thread (General / orphan topic). */ messageThreadId?: number },
  ): Promise<{ message_id: number }> {
    const body = opts?.html ? formatForTelegram(text) : { text, parseMode: undefined };
    return env.telegram.sendMessage({
      chatId,
      text: body.text,
      ...(body.parseMode ? { parseMode: body.parseMode } : {}),
      ...(opts?.messageThreadId !== undefined
        ? { messageThreadId: opts.messageThreadId }
        : {}),
      ...(replyMarkup !== undefined ? { replyMarkup } : {}),
    });
  }

  async function sendInTopic(
    session: PersistedSession,
    text: string,
    replyMarkup?: unknown,
    opts?: { html?: boolean; alreadyHtml?: boolean },
  ): Promise<{ message_id: number }> {
    if (
      session.messageThreadId === undefined ||
      session.messageThreadId === null
    ) {
      throw new Error(
        "refusing to send session message without message_thread_id",
      );
    }
    const formatted = opts?.alreadyHtml
      ? { text, parseMode: "HTML" as const }
      : opts?.html === false
        ? { text, parseMode: undefined as string | undefined }
        : formatForTelegram(text);

    // Chunk long HTML
    const chunks =
      formatted.parseMode === "HTML"
        ? chunkHtmlForTelegram(formatted.text)
        : [formatted.text];

    let last = { message_id: 0 };
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const chunk = chunks[i]!;
      try {
        last = await env.telegram.sendMessage({
          chatId: session.chatId,
          text: chunk,
          messageThreadId: session.messageThreadId,
          ...(formatted.parseMode ? { parseMode: formatted.parseMode } : {}),
          ...(isLast && replyMarkup !== undefined ? { replyMarkup } : {}),
        });
      } catch (err) {
        // Invalid HTML from model markdown → plain text fallback
        log.warn("HTML send failed; plain fallback", {
          error: err instanceof Error ? err.message : String(err),
        });
        last = await env.telegram.sendMessage({
          chatId: session.chatId,
          text: chunk
            .replace(/<[^>]+>/g, "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&"),
          messageThreadId: session.messageThreadId,
          ...(isLast && replyMarkup !== undefined ? { replyMarkup } : {}),
        });
      }
    }
    return last;
  }

  function wirePermissionHandler(): void {
    if (permissionWired) return;
    permissionWired = true;

    if (env.agents.setPermissionHandler) {
      env.agents.setPermissionHandler(async (req, ctx) => {
        return handlePermissionRequest(req, ctx);
      });
    }
    if (env.agents.setElicitationHandler) {
      env.agents.setElicitationHandler(async (req, ctx) => {
        return handleElicitationRequest(req, ctx);
      });
    }
    if (env.agents.setAskUserQuestionHandler) {
      env.agents.setAskUserQuestionHandler(async (req, ctx) => {
        return handleAskUserQuestion(req, ctx);
      });
    }
  }

  /**
   * Permission UI is allowed to await Telegram — it runs on the acpx host
   * hook, not inside the event-queue drain consumer.
   * Rename to waiting-on-you BEFORE the prompt message is sent.
   */
  async function handlePermissionRequest(
    req: PermissionRequest,
    ctx: { signal: AbortSignal },
  ): Promise<PermissionDecision | undefined> {
    const sessionKey = req.sessionId;
    const session = sessionIndex.byKey[sessionKey];
    if (!session) {
      log.warn("permission for unknown session; reject", { sessionKey });
      return { outcome: "reject_once" };
    }

    log.info("permission UI: rename waiting-on-you", {
      sessionKey,
      toolCallId: req.toolCallId,
    });
    // Status first so the topic list is correct when the notification lands.
    await renameTopic(session, "waiting-on-you");

    const ui = buildPermissionUi(req);
    log.info("permission UI: send keyboard", {
      sessionKey,
      token: ui.token,
      options: ui.options.map((o) => o.name),
    });
    // Permission prompt is plain-ish; format markdown in the body.
    const sent = await sendInTopic(session, ui.text, ui.keyboard, {
      html: true,
    });

    log.info("permission UI: waiting for operator", {
      sessionKey,
      token: ui.token,
      messageId: sent.message_id,
    });
    const decision = await new Promise<PermissionDecision>((resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(ctx.signal.reason ?? new Error("aborted"));
        return;
      }
      const onAbort = () => {
        log.warn("permission aborted (cancel/signal)", { sessionKey });
        permissions.cancelAllForSession(sessionKey, { outcome: "cancel" });
        reject(ctx.signal.reason ?? new Error("aborted"));
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      permissions.register({
        token: ui.token,
        sessionKey,
        chatId: session.chatId,
        messageThreadId: session.messageThreadId,
        messageId: sent.message_id,
        options: ui.options,
        promptText: ui.text,
        settled: false,
        resolve: (d) => {
          ctx.signal.removeEventListener("abort", onAbort);
          resolve(d);
        },
      });
    }).catch(() => ({ outcome: "cancel" as const }));

    log.info("permission UI: settled", {
      sessionKey,
      decision: decision.outcome,
    });

    // Confirm by editing the message — never rely on answerCallbackQuery.
    try {
      const formatted = formatForTelegram(
        `${ui.text}\n\n→ **answered:** ${decision.outcome}`,
      );
      await env.telegram.editMessageText({
        chatId: session.chatId,
        messageId: sent.message_id,
        text: formatted.text,
        parseMode: formatted.parseMode,
        replyMarkup: { inline_keyboard: [] },
      });
    } catch (err) {
      log.warn("permission confirm edit failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (session.status === "waiting-on-you") {
      await renameTopic(session, "running");
    }

    return decision;
  }

  async function handlePermissionCallback(
    data: string,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    const parsed = parsePermissionCallback(data);
    if (!parsed) return;

    const pending = permissions.get(parsed.token);
    const decision = permissions.settle(parsed.token, parsed.optionIndex);

    // Always try to clear the keyboard via edit; answerCallbackQuery is best-effort only.
    if (message && pending) {
      try {
        const formatted = formatForTelegram(
          `${pending.promptText}\n\n→ **answered:** ${decision?.outcome ?? "—"}`,
        );
        await env.telegram.editMessageText({
          chatId: message.chat.id,
          messageId: message.message_id,
          text: formatted.text,
          parseMode: formatted.parseMode,
          replyMarkup: { inline_keyboard: [] },
        });
      } catch {
        /* ignore */
      }
    }

    try {
      await env.telegram.answerCallbackQuery({
        callbackQueryId,
        text: decision ? "Recorded" : "Already answered",
      });
    } catch {
      /* assume always fails after restart — confirmation is the edit */
    }
  }

  /**
   * Structured agent questions → multi-choice Telegram buttons.
   */
  async function handleElicitationRequest(
    req: { sessionId: string; raw: unknown },
    ctx: { signal: AbortSignal },
  ): Promise<
    | { action: "accept"; content?: Record<string, unknown> }
    | { action: "decline" }
    | { action: "cancel" }
    | undefined
  > {
    const sessionKey = req.sessionId;
    const session = sessionIndex.byKey[sessionKey];
    if (!session) {
      log.warn("elicitation for unknown session; decline", { sessionKey });
      return { action: "decline" };
    }

    await renameTopic(session, "waiting-on-you");

    const ui = buildElicitationUi({ sessionId: sessionKey, raw: req.raw });
    log.info("elicitation UI: send keyboard", {
      sessionKey,
      token: ui.token,
      options: ui.options.map((o) => o.label),
    });

    const sent = await sendInTopic(session, ui.text, ui.keyboard, {
      alreadyHtml: true,
    });

    log.info("elicitation UI: waiting for operator", {
      sessionKey,
      token: ui.token,
      messageId: sent.message_id,
    });

    const decision = await new Promise<
      | { action: "accept"; content?: Record<string, unknown> }
      | { action: "decline" }
      | { action: "cancel" }
    >((resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(ctx.signal.reason ?? new Error("aborted"));
        return;
      }
      const onAbort = () => {
        elicitations.cancelAllForSession(sessionKey);
        reject(ctx.signal.reason ?? new Error("aborted"));
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      elicitations.register({
        token: ui.token,
        sessionKey,
        chatId: session.chatId,
        messageThreadId: session.messageThreadId,
        messageId: sent.message_id,
        fieldName: ui.fieldName,
        options: ui.options,
        promptText: ui.text,
        settled: false,
        resolve: (d) => {
          ctx.signal.removeEventListener("abort", onAbort);
          resolve(d);
        },
      });
    }).catch(() => ({ action: "cancel" as const }));

    log.info("elicitation UI: settled", { sessionKey, decision });

    try {
      const summary =
        decision.action === "accept"
          ? `→ chose: ${JSON.stringify(decision.content)}`
          : `→ ${decision.action}`;
      await env.telegram.editMessageText({
        chatId: session.chatId,
        messageId: sent.message_id,
        text: `${ui.text}\n\n${summary}`,
        parseMode: "HTML",
        replyMarkup: { inline_keyboard: [] },
      });
    } catch (err) {
      log.warn("elicitation confirm edit failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (session.status === "waiting-on-you") {
      await renameTopic(session, "running");
    }
    return decision;
  }

  /**
   * Grok `_x.ai/ask_user_question` → sequential multi-choice Telegram keyboards.
   */
  async function handleAskUserQuestion(
    req: { sessionId: string; raw: unknown },
    ctx: { signal: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const sessionKey = req.sessionId;
    const session = sessionIndex.byKey[sessionKey];
    if (!session) {
      log.warn("ask_user_question unknown session", { sessionKey });
      return toAskUserQuestionExtResponse({ answers: [] }, { declined: true });
    }

    const questions = parseAskUserQuestions(req.raw);
    if (questions.length === 0) {
      log.warn("ask_user_question empty questions", { sessionKey });
      return toAskUserQuestionExtResponse({ answers: [] }, { declined: true });
    }

    await renameTopic(session, "waiting-on-you");

    const token = newAskToken();
    const first = buildAskQuestionUi(token, 0, questions.length, questions[0]!);
    log.info("ask_user_question UI", {
      sessionKey,
      token,
      count: questions.length,
      first: questions[0]?.question.slice(0, 80),
    });

    const sent = await sendInTopic(session, first.text, first.keyboard, {
      alreadyHtml: true,
    });

    const result = await new Promise<{
      answers: Array<{
        question: string;
        header?: string;
        selectedOptions: string[];
      }>;
    }>((resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(ctx.signal.reason ?? new Error("aborted"));
        return;
      }
      const onAbort = () => {
        askQuestions.cancelAllForSession(sessionKey);
        reject(ctx.signal.reason ?? new Error("aborted"));
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      askQuestions.register({
        token,
        sessionKey,
        chatId: session.chatId,
        messageThreadId: session.messageThreadId,
        questions,
        answers: questions.map(() => []),
        currentIndex: 0,
        messageId: sent.message_id,
        selected: new Set(),
        settled: false,
        resolve: (r) => {
          ctx.signal.removeEventListener("abort", onAbort);
          resolve(r);
        },
      });
    }).catch(() => ({
      answers: questions.map((q) => ({
        question: q.question,
        header: q.header,
        selectedOptions: [] as string[],
      })),
    }));

    const wire = toAskUserQuestionExtResponse(result);
    log.info("ask_user_question settled", {
      sessionKey,
      answers: result.answers,
      wireOutcome: wire.outcome,
    });

    try {
      const summary = result.answers
        .map(
          (a) =>
            `• ${a.question.slice(0, 60)} → ${a.selectedOptions.join(", ") || "(skipped)"}`,
        )
        .join("\n");
      await env.telegram.editMessageText({
        chatId: session.chatId,
        messageId: sent.message_id,
        text: formatForTelegram(
          `**Answers recorded**\n\n${summary}`,
        ).text,
        parseMode: "HTML",
        replyMarkup: { inline_keyboard: [] },
      });
    } catch {
      /* ignore — often races with callback handler's final edit */
    }

    if (session.status === "waiting-on-you") {
      await renameTopic(session, "running");
    }

    return wire;
  }

  async function handleAskQuestionCallback(
    data: string,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    const parsed = parseAskQuestionCallback(data);
    if (!parsed) return;

    const pending = askQuestions.get(parsed.token);
    const outcome = askQuestions.handleOption(
      parsed.token,
      parsed.questionIndex,
      parsed.optionIndex,
    );

    try {
      await env.telegram.answerCallbackQuery({
        callbackQueryId,
        text: outcome ? "OK" : "Already answered",
      });
    } catch {
      /* ignore */
    }

    if (!outcome || !message) return;

    if (outcome.kind === "progress") {
      try {
        await env.telegram.editMessageText({
          chatId: message.chat.id,
          messageId: message.message_id,
          text: outcome.ui.text,
          parseMode: "HTML",
          replyMarkup: outcome.ui.keyboard,
        });
        if (pending) pending.messageId = message.message_id;
      } catch (err) {
        log.warn("ask_user_question progress edit failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // done — final edit may race with handleAskUserQuestion's own edit
    try {
      const summary = outcome.result.answers
        .map(
          (a) =>
            `• ${a.question.slice(0, 60)} → ${a.selectedOptions.join(", ") || "(skipped)"}`,
        )
        .join("\n");
      await env.telegram.editMessageText({
        chatId: message.chat.id,
        messageId: message.message_id,
        text: formatForTelegram(`**Answers recorded**\n\n${summary}`).text,
        parseMode: "HTML",
        replyMarkup: { inline_keyboard: [] },
      });
    } catch {
      /* ignore */
    }
  }

  async function handleElicitationCallback(
    data: string,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    const parsed = parseElicitationCallback(data);
    if (!parsed) return;

    const pending = elicitations.get(parsed.token);
    const decision = elicitations.settle(parsed.token, parsed.optionIndex);

    if (message && pending) {
      try {
        const summary =
          decision?.action === "accept"
            ? `→ chose: ${JSON.stringify(decision.content)}`
            : `→ ${decision?.action ?? "—"}`;
        await env.telegram.editMessageText({
          chatId: message.chat.id,
          messageId: message.message_id,
          text: `${pending.promptText}\n\n${summary}`,
          parseMode: "HTML",
          replyMarkup: { inline_keyboard: [] },
        });
      } catch {
        /* ignore */
      }
    }

    try {
      await env.telegram.answerCallbackQuery({
        callbackQueryId,
        text: decision ? "Recorded" : "Already answered",
      });
    } catch {
      /* ignore */
    }
  }

  async function offerRepoPicker(chatId: number): Promise<void> {
    const keys = repoKeys();
    if (keys.length === 0) {
      await replyInRoot(
        chatId,
        "No repos configured. Set TACP_REPOS_JSON, e.g. {\"tacp\":\"/path/to/repo\"}.\n" +
          "Or use /new <repo> <name> once configured.",
      );
      return;
    }
    const buttons = keys.map((k, i) => ({
      text: k,
      callback_data: encodeNewRepoCallback(i),
    }));
    await replyInRoot(
      chatId,
      "Which repo?\n(or /new <repo> <name> to skip the picker)",
      keyboardFromButtons(buttons),
    );
  }

  async function handleNewRepoCallback(
    repoIndex: number,
    chatId: number,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    const keys = repoKeys();
    const repo = keys[repoIndex];
    try {
      await env.telegram.answerCallbackQuery({ callbackQueryId });
    } catch {
      /* ignore */
    }
    if (!repo) {
      await replyInRoot(chatId, "Unknown repo selection.");
      return;
    }
    enterPendingNew(repo, chatId);
    const prompt =
      `Repo: **${repo}**\n\n` +
      "Send a **one-word** session name (e.g. `auth-refactor`).\n" +
      "This creates one topic, then naming mode ends.\n" +
      "Cancel: /ping or any other command.";
    if (message) {
      try {
        await env.telegram.editMessageText({
          chatId,
          messageId: message.message_id,
          text: formatForTelegram(prompt).text,
          parseMode: "HTML",
          replyMarkup: { inline_keyboard: [] },
        });
      } catch {
        await replyInRoot(chatId, prompt, undefined, { html: true });
      }
    } else {
      await replyInRoot(chatId, prompt, undefined, { html: true });
    }
  }

  async function createSessionFromLobby(
    chatId: number,
    repo: string,
    name: string,
  ): Promise<void> {
    // Exit naming mode *before* any await so a second free-text cannot race
    // into another createForumTopic while the first is in flight.
    clearPendingNew("name accepted → create");
    try {
      const session = await createSession({
        repo,
        name,
        agent: env.config.defaultAgent,
      });
      // Belt-and-suspenders: createSession also clears.
      clearPendingNew("after createSession");
      await replyInRoot(
        chatId,
        `✓ Session **${session.sessionKey}** ready — open that topic to chat.\n\n` +
          `Naming mode is **off**. Lobby free-text will not create topics.\n` +
          `Start another with /new.`,
        undefined,
        { html: true },
      );
    } catch (err) {
      clearPendingNew("create failed");
      await replyInRoot(
        chatId,
        `Could not create session: ${err instanceof Error ? err.message : String(err)}\nSend /new to try again.`,
      );
    }
  }

  async function handleRootCommand(
    msg: TelegramMessage,
    text: string,
  ): Promise<void> {
    const chatId = msg.chat.id;
    await ensureOperatorChat(chatId);
    const lobbyReply = (
      body: string,
      replyMarkup?: unknown,
      extra?: { html?: boolean },
    ) => replyInRoot(chatId, body, replyMarkup, extra);

    const trimmed = text.trim();
    const slash = parseSlashCommand(trimmed);

    // Free-text only while naming mode is active (after repo pick).
    if (pendingName && pendingName.chatId === chatId && !slash) {
      const name = parseSessionNameCandidate(trimmed);
      if (!name) {
        await lobbyReply(
          `Still in **/new** naming mode for **${pendingName.repo}**.\n` +
            "Send **one word** (e.g. `auth-fix`), or /ping to cancel.",
          undefined,
          { html: true },
        );
        return;
      }
      // Snapshot + clear *before* create so "hello" / "ok" cannot spawn more.
      const repo = pendingName.repo;
      clearPendingNew("free-text name accepted");
      await createSessionFromLobby(chatId, repo, name);
      return;
    }

    // Any slash command cancels naming mode.
    if (slash) {
      const wasNaming = clearPendingNew(`slash ${slash.name}`);
      if (wasNaming && slash.name === "/ping") {
        await lobbyReply("Cancelled /new naming mode.\npong");
        return;
      }
    }

    if (!slash) {
      // Lobby is commands-only when not naming.
      return;
    }

    if (!isKnownCommand(slash.name)) {
      await lobbyReply(unknownCommandMessage("lobby"));
      return;
    }

    if (!commandAllowedIn(slash.name, "lobby")) {
      await lobbyReply(wrongScopeMessage(slash.name, "lobby"));
      return;
    }

    switch (slash.name) {
      case "/ping":
        await lobbyReply(PING_REPLY);
        return;
      case "/new": {
        const repo = slash.args[0];
        const name = slash.args[1];
        if (!repo || !name) {
          await offerRepoPicker(chatId);
          return;
        }
        const ok = parseSessionNameCandidate(name);
        if (!ok) {
          await lobbyReply(
            "Session name must be one short token (letters/digits/`-`/`_`/`.`).",
            undefined,
            { html: true },
          );
          return;
        }
        // Full /new repo name — no intermediate naming mode.
        clearPendingNew("/new with args");
        await createSessionFromLobby(chatId, repo, ok);
        return;
      }
      case "/sessions": {
        const sessions = await listSessions();
        if (sessions.length === 0) {
          await lobbyReply("No sessions.");
          return;
        }
        const lines = sessions.map(
          (s) =>
            `${topicName(s.identity.repo, s.identity.name, s.status)}  (thread ${s.messageThreadId})`,
        );
        await lobbyReply(lines.join("\n"));
        return;
      }
      case "/help":
        await lobbyReply(lobbyHelpText());
        return;
      default:
        await lobbyReply(unknownCommandMessage("lobby"));
    }
  }

  function clearSkillFlow(sessionKey: string, reason: string): void {
    if (skillTextPending.delete(sessionKey)) {
      log.info("clear skill text pending", { sessionKey, reason });
    }
    for (const [token, pick] of [...skillPicks]) {
      if (pick.sessionKey === sessionKey) skillPicks.delete(token);
    }
  }

  async function cancelSessionTurn(session: PersistedSession): Promise<void> {
    log.info("action: /cancel", { sessionKey: session.sessionKey });
    clearSkillFlow(session.sessionKey, "/cancel");
    permissions.cancelAllForSession(session.sessionKey, {
      outcome: "cancel",
    });
    elicitations.cancelAllForSession(session.sessionKey);
    askQuestions.cancelAllForSession(session.sessionKey);
    const ac = turnAbort.get(session.sessionKey);
    ac?.abort();
    turnAbort.delete(session.sessionKey);
    if (env.agents.cancelTurn) {
      await env.agents.cancelTurn(session.sessionKey, "operator /cancel");
    }
    await renameTopic(session, "idle");
    await sendInTopic(session, "⏹ turn cancelled — session kept", undefined, {
      html: true,
    });
  }

  /**
   * Drain events without awaiting Telegram inside the consumer loop.
   */
  async function drainTurn(
    session: PersistedSession,
    events: AsyncIterable<AcpTurnEvent>,
  ): Promise<void> {
    let status: SessionStatus = session.status;
    const statusTransitions: SessionStatus[] = [];
    const textParts: string[] = [];
    let deathError: string | undefined;
    /** Agent requested voice (tool or will parse marker from reply). */
    let speakFromTool: SpeakRequest | undefined;

    try {
      for await (const event of events) {
        const next = reduceStatus(status, event);
        if (next !== status) {
          status = next;
          statusTransitions.push(next);
        }
        if (event.type === "agent_message_chunk" && event.text) {
          textParts.push(event.text);
        }
        if (event.type === "tool_call") {
          // Any MCP telegram text tool: drain so the tool can ack mid-turn.
          if (isTelegramTextToolName(event.title)) {
            log.info("agent requested telegram text (tool/mcp)", {
              sessionKey: session.sessionKey,
              title: event.title,
            });
            await drainTelegramQueue();
          }
          if (isSpeakToolName(event.title)) {
            const text = speakTextFromToolInput(event.rawInput);
            speakFromTool = {
              source: "tool",
              text,
            };
            log.info("agent requested speak (tool/mcp)", {
              sessionKey: session.sessionKey,
              title: event.title,
              hasText: Boolean(text),
            });
            // MCP speak enqueues a job and waits for ack — drain now so the
            // MCP tool can complete (do not rely on <<<speak>>> markers).
            const ttsMode = env.config.ttsMode ?? "agent";
            if (ttsMode !== "off") {
              await drainSpeakQueue();
              // If queue already delivered this tool's text, skip end-of-turn TTS.
              if (text?.trim()) {
                speakFromTool = { source: "tool", text: "" };
              }
            }
          }
        }
        if (event.type === "process_died") {
          deathError = event.error ?? "process died";
          if (status !== "failed") {
            status = "failed";
            statusTransitions.push("failed");
          }
        }
      }
    } catch (err) {
      status = "failed";
      statusTransitions.push("failed");
      deathError =
        deathError ?? (err instanceof Error ? err.message : String(err));
    }

    try {
      // Skip intermediate waiting-on-you here if permission handler already set it;
      // still apply final statuses from the stream.
      for (const s of statusTransitions) {
        if (s === "waiting-on-you" && session.status === "waiting-on-you") {
          continue;
        }
        await renameTopic(session, s);
      }
      if (statusTransitions.length === 0 && session.status !== status) {
        await renameTopic(session, status);
      }

      if (deathError) {
        await sendInTopic(
          session,
          `**Agent failed**\n\n\`${deathError}\``,
          undefined,
          { html: true },
        );
        return;
      }

      if (status === "idle" && textParts.length === 0) {
        // cancelled path may already have messaged
        return;
      }

      const rawReply = textParts.join("");
      const { visibleText, speak: speakFromMarker } =
        extractSpeakFromReply(rawReply);
      const ttsMode = env.config.ttsMode ?? "agent";
      const speakReq: SpeakRequest | undefined =
        ttsMode === "always"
          ? { source: "marker", text: undefined }
          : ttsMode === "off"
            ? undefined
            : (speakFromTool ?? speakFromMarker);

      if (visibleText.trim()) {
        await sendInTopic(session, visibleText, undefined, { html: true });
      } else if (status === "done" && !speakReq) {
        await sendInTopic(session, "✓ turn finished (no text output)", undefined, {
          html: true,
        });
      }

      if (speakReq) {
        // Empty text after mid-turn MCP delivery means already spoken.
        const alreadySpokenViaTool =
          speakReq.source === "tool" && speakReq.text === "";
        if (!alreadySpokenViaTool) {
          const toSpeak =
            speakReq.text?.trim() ||
            visibleText.trim() ||
            rawReply.trim();
          await maybeSendTts(session, toSpeak, speakReq.source);
        }
      }
      // Catch MCP speak / telegram jobs that finished enqueue after tool_call.
      await drainTelegramQueue();
      await drainSpeakQueue();
    } catch (err) {
      try {
        await renameTopic(session, "failed");
        await sendInTopic(
          session,
          `✕ turn error: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        /* ignore */
      }
    }
  }


  /**
   * MCP update / telegram_send tools enqueue text; deliver to the topic.
   */
  async function drainTelegramQueue(): Promise<void> {
    const stateDir =
      process.env.TACP_ACPX_STATE_DIR?.trim() || "./data/acpx-state";
    const qDir = telegramQueueDir(stateDir);
    let jobs;
    try {
      jobs = await listPendingTelegramJobs(qDir);
    } catch {
      return;
    }
    for (const job of jobs) {
      const session = sessionIndex.byKey[job.sessionKey];
      if (!session) {
        await completeTelegramJob(
          job,
          { ok: false, error: `unknown sessionKey: ${job.sessionKey}` },
          qDir,
        );
        log.warn("telegram queue: unknown session", {
          sessionKey: job.sessionKey,
          id: job.id,
          kind: job.kind,
        });
        continue;
      }
      try {
        const prefix = job.kind === "update" ? "↻ " : "";
        await sendInTopic(session, `${prefix}${job.text}`);
        await completeTelegramJob(job, { ok: true }, qDir);
        log.info("telegram queue: delivered", {
          sessionKey: job.sessionKey,
          id: job.id,
          kind: job.kind,
          textLen: job.text.length,
        });
      } catch (err) {
        await completeTelegramJob(
          job,
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          qDir,
        );
      }
    }
  }

  /**
   * MCP speak tool enqueues jobs; deliver TTS to the matching Telegram topic.
   */
  async function drainSpeakQueue(): Promise<void> {
    const stateDir =
      process.env.TACP_ACPX_STATE_DIR?.trim() || "./data/acpx-state";
    let jobs;
    try {
      jobs = await listPendingSpeakJobs(speakQueueDir(stateDir));
    } catch {
      return;
    }
    for (const job of jobs) {
      const session = sessionIndex.byKey[job.sessionKey];
      if (!session) {
        await completeSpeakJob(job, {
          ok: false,
          error: `unknown sessionKey: ${job.sessionKey}`,
        }, speakQueueDir(stateDir));
        log.warn("speak queue: unknown session", {
          sessionKey: job.sessionKey,
          id: job.id,
        });
        continue;
      }
      try {
        const ok = await maybeSendTts(session, job.text, "mcp-speak");
        if (ok) {
          await completeSpeakJob(
            job,
            { ok: true },
            speakQueueDir(stateDir),
          );
          log.info("speak queue: delivered", {
            sessionKey: job.sessionKey,
            id: job.id,
            textLen: job.text.length,
          });
        } else {
          await completeSpeakJob(
            job,
            {
              ok: false,
              error: "TTS unavailable or empty text",
            },
            speakQueueDir(stateDir),
          );
        }
      } catch (err) {
        await completeSpeakJob(
          job,
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          speakQueueDir(stateDir),
        );
      }
    }
  }

    /** @returns true when a voice note was sent */
  async function maybeSendTts(
    session: PersistedSession,
    replyText: string,
    source: string,
  ): Promise<boolean> {
    if (!env.speech?.tts || !env.telegram.sendVoice) {
      log.warn("speak requested but TTS unavailable", {
        sessionKey: session.sessionKey,
        source,
      });
      return false;
    }
    const spoken = textForTts(replyText);
    if (!spoken) return false;
    try {
      const audio = await env.speech.tts(spoken);
      await env.telegram.sendVoice({
        chatId: session.chatId,
        messageThreadId: session.messageThreadId,
        data: audio.data,
        filename: audio.filename,
      });
      log.info("tts sent", {
        sessionKey: session.sessionKey,
        source,
        bytes: audio.data.byteLength,
      });
      return true;
    } catch (err) {
      log.warn("tts failed", {
        sessionKey: session.sessionKey,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }


  /**
   * /mcp [status|add|remove|auth|code] — repo `.tacp/mcp.json` registry + host OAuth.
   * Uses session.cwd (topic-bound repo). Tokens never written to the repo.
   */
  async function handleMcpCommand(
    session: PersistedSession,
    args: string[],
  ): Promise<void> {
    const repoRoot = session.cwd;
    const repoKey = repoKeyForOAuth(session.identity.repo, repoRoot);
    const oauthStateDir = acpxStateDir;
    const oauthConfigured = Boolean(
      process.env.TACP_OAUTH_CALLBACK_BASE?.trim(),
    );
    const sub = (args[0] ?? "status").toLowerCase();

    try {
      if (args.length === 0 || sub === "status") {
        if (args.length > 1) {
          await sendInTopic(session, MCP_COMMAND_USAGE);
          return;
        }
        const config = await readMcpConfig(repoRoot);
        const tokenIds = oauthConfigured
          ? await listOAuthTokenIds(oauthStateDir, repoKey)
          : [];
        await sendInTopic(
          session,
          formatMcpRegistryStatus(config, repoRoot, {
            tokenIds,
            oauthEnabled: oauthConfigured,
          }),
        );
        return;
      }

      if (sub === "add") {
        const id = args[1];
        const url = args[2];
        if (!id || !url || args.length > 3) {
          await sendInTopic(
            session,
            "Usage: `/mcp add <id> <url>`\n\nOnly id and url are stored (no tokens).",
          );
          return;
        }
        const entry = await writeRemoteMcpServer(repoRoot, {
          name: id,
          url,
        });
        log.info("mcp registry add", {
          sessionKey: session.sessionKey,
          name: entry.name,
          type: entry.type,
          // url only — never log tokens (none accepted)
          url: entry.url,
        });
        await sendInTopic(
          session,
          `Added MCP **${entry.name}** (${entry.type})\n${entry.url}\n\n` +
            `Written to \`.tacp/mcp.json\` (id + url only; no tokens).\n` +
            `Authorize with \`/mcp auth ${entry.name}\` if the gateway needs OAuth.\n` +
            `Active on next session ensure / restart.`,
        );
        return;
      }

      if (sub === "remove") {
        const id = args[1];
        if (!id || args.length > 2) {
          await sendInTopic(session, "Usage: `/mcp remove <id>`");
          return;
        }
        const removed = await removeMcpServer(repoRoot, id);
        if (!removed) {
          await sendInTopic(
            session,
            `No MCP entry named **${id}** in \`.tacp/mcp.json\`.`,
          );
          return;
        }
        log.info("mcp registry remove", {
          sessionKey: session.sessionKey,
          name: id,
        });
        await sendInTopic(
          session,
          `Removed MCP **${id}** from \`.tacp/mcp.json\`.`,
        );
        return;
      }

      if (sub === "auth") {
        const id = args[1];
        if (!id || args.length > 2) {
          await sendInTopic(session, "Usage: `/mcp auth <id>`");
          return;
        }
        const config = await readMcpConfig(repoRoot);
        const entry = config.mcpServers.find(
          (s) => typeof s.name === "string" && s.name.trim() === id.trim(),
        );
        if (!entry || typeof entry.url !== "string" || !entry.url.trim()) {
          await sendInTopic(
            session,
            `No remote MCP **${id}** with a url in \`.tacp/mcp.json\`.\n` +
              `Add one first: \`/mcp add ${id} <url>\``,
          );
          return;
        }
        const started = await startMcpOAuth({
          id: id.trim(),
          resourceUrl: entry.url.trim(),
          repoRoot,
          repoKey,
          stateDir: oauthStateDir,
        });
        log.info("mcp oauth auth started", {
          sessionKey: session.sessionKey,
          id: started.id,
          repoKey: started.repoKey,
          // never log verifier / tokens
        });
        // Tappable authorize URL in Telegram — do NOT open a browser on the host.
        await sendInTopic(
          session,
          `Authorize MCP **${started.id}** (open on your phone):\n\n` +
            `${started.authorizeUrl}\n\n` +
            `Discovered client \`${started.clientId}\` · resource \`${started.resource}\`\n` +
            `Redirect: \`${started.redirectUri}\`\n` +
            `OAuth state dir (must match acp-host): \`${oauthStateDir}\`\n` +
            `Pending expires in 15 minutes. Tokens stay on the host (not in the repo).\n` +
            `Active on next ensure.\n\n` +
            `If the browser cannot reach the host (or acp-host OAuth listen failed), ` +
            `paste the **full** final redirect URL:\n` +
            `\`/mcp code <callback-url>\``,
        );
        return;
      }

      if (sub === "code") {
        // /mcp code <callback-url-or-code> [id]
        const payload = args[1];
        const idHint = args[2];
        if (!payload || args.length > 3) {
          await sendInTopic(
            session,
            "Usage: `/mcp code <callback-url-or-code> [id]`\n\n" +
              "Prefer the full redirect URL (code + state). " +
              "Fallback when the OAuth redirect cannot reach this host.",
          );
          return;
        }
        const result = await completeMcpOAuthFromPaste({
          callbackUrlOrCode: payload,
          ...(idHint ? { id: idHint } : {}),
          repoKey,
          stateDir: oauthStateDir,
        });
        log.info("mcp oauth code complete", {
          sessionKey: session.sessionKey,
          id: result.id,
          repoKey: result.repoKey,
        });
        await sendInTopic(
          session,
          `OAuth complete for MCP **${result.id}**.\n` +
            `Token stored on host (not in repo). Active on next session ensure / restart.`,
        );
        return;
      }

      await sendInTopic(session, MCP_COMMAND_USAGE);
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : String(err);
      // Full multi-line body — do not compress into one truncated log-style line.
      await sendInTopic(
        session,
        `MCP registry error\n\n${detail}`,
      );
      log.warn("mcp command failed", {
        sessionKey: session.sessionKey,
        error: detail,
      });
    }
  }

  async function applySessionMode(
    session: PersistedSession,
    modeId: string,
    via: string,
  ): Promise<void> {
    if (!env.agents.setSessionMode) {
      await sendInTopic(
        session,
        "This agent backend does not support session modes.",
      );
      return;
    }
    try {
      const next = await env.agents.setSessionMode(session.sessionKey, modeId);
      const cur = next.currentModeId ?? modeId;
      const avail = next.availableModeIds ?? [];
      await sendInTopic(
        session,
        `Mode → **\`${cur}\`**\n\n` +
          formatModeStatus({ current: cur, available: avail }),
        undefined,
        { html: true },
      );
      log.info("session mode set", {
        sessionKey: session.sessionKey,
        modeId: cur,
        via,
      });
    } catch (err) {
      await sendInTopic(
        session,
        `Failed to set mode \`${modeId}\`: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * /mode with no args → inline picker of advertised modes.
   */
  async function showModePicker(session: PersistedSession): Promise<void> {
    if (!env.agents.getSessionMode || !env.agents.setSessionMode) {
      await sendInTopic(
        session,
        "This agent backend does not support session modes.",
      );
      return;
    }
    try {
      await env.agents.ensureSession(session.identity);
    } catch (err) {
      await sendInTopic(
        session,
        `Could not attach agent: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const state = await env.agents.getSessionMode(session.sessionKey);
    const available = state.availableModeIds ?? [];
    if (available.length === 0) {
      await sendInTopic(
        session,
        formatModeStatus({
          current: state.currentModeId,
          available,
        }),
        undefined,
        { html: true },
      );
      return;
    }

    const token = newToken();
    modePicks.set(token, {
      sessionKey: session.sessionKey,
      modes: available,
      ...(state.currentModeId ? { current: state.currentModeId } : {}),
    });
    const buttons = available.map((id, i) => ({
      text:
        (id === state.currentModeId ? "✓ " : "") +
        (id.length > 28 ? `${id.slice(0, 27)}…` : id),
      callback_data: encodeModeCallback(token, i),
    }));
    buttons.push({
      text: "Cancel",
      callback_data: encodeModeCallback(token, -1),
    });
    await sendInTopic(
      session,
      formatModeStatus({
        current: state.currentModeId,
        available,
      }) + "\n\n_Pick a mode:_",
      keyboardFromButtons(buttons),
      { html: true },
    );
  }

  /**
   * /plan /build /mode — ACP session/set_mode control (like acpx session modes).
   */
  async function handleSessionModeCommand(
    session: PersistedSession,
    name: string,
    args: string[],
  ): Promise<void> {
    try {
      await env.agents.ensureSession(session.identity);
    } catch (err) {
      await sendInTopic(
        session,
        `Could not attach agent: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (!env.agents.getSessionMode || !env.agents.setSessionMode) {
      await sendInTopic(
        session,
        "This agent backend does not support session modes.",
      );
      return;
    }

    const state = await env.agents.getSessionMode(session.sessionKey);
    const available = state.availableModeIds ?? [];

    // /mode → button list (not silent toggle)
    if (name === "/mode" && args.length === 0) {
      await showModePicker(session);
      return;
    }

    // /mode toggle → plan ↔ build
    if (
      name === "/mode" &&
      args.length === 1 &&
      args[0]!.toLowerCase() === "toggle"
    ) {
      const target = togglePlanBuildModeId(state.currentModeId, available);
      if (!target || target === state.currentModeId) {
        await sendInTopic(
          session,
          formatModeStatus({
            current: state.currentModeId,
            available,
          }),
          undefined,
          { html: true },
        );
        return;
      }
      await applySessionMode(session, target, "/mode toggle");
      return;
    }

    let modeId: string | undefined;
    if (name === "/plan") {
      modeId = resolvePlanModeId(available);
    } else if (name === "/build") {
      modeId = resolveBuildModeId(available);
    } else {
      const token = args[0] ?? "";
      modeId = resolveModeToken(token, available);
      if (!modeId && available.length === 0 && token) {
        modeId = token;
      }
    }

    if (!modeId) {
      await sendInTopic(
        session,
        `No matching mode.\n\n` +
          formatModeStatus({
            current: state.currentModeId,
            available,
          }),
        undefined,
        { html: true },
      );
      return;
    }

    if (modeId === state.currentModeId) {
      await sendInTopic(
        session,
        formatModeStatus({
          current: state.currentModeId,
          available,
        }),
        undefined,
        { html: true },
      );
      return;
    }

    await applySessionMode(session, modeId, name);
  }

  async function handleStatusCommand(session: PersistedSession): Promise<void> {
    const agent =
      session.identity.agent ??
      env.config.defaultAgent ??
      "grok-build";
    const launch = resolveAgentLaunch(agent);

    let mode: string | undefined;
    let availableModes: string[] = [];
    try {
      await env.agents.ensureSession(session.identity);
      if (env.agents.getSessionMode) {
        const st = await env.agents.getSessionMode(session.sessionKey);
        mode = st.currentModeId;
        availableModes = st.availableModeIds ?? [];
      }
    } catch (err) {
      log.warn("status: ensure/getSessionMode failed", {
        sessionKey: session.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let mcpCount = 0;
    let mcpNames: string[] = [];
    const mcpEnabled = env.config.mcpEnabled !== false;
    if (mcpEnabled) {
      try {
        const servers = await buildSessionMcpServers({
          cwd: session.cwd,
          sessionKey: session.sessionKey,
          stateDir:
            process.env.TACP_ACPX_STATE_DIR?.trim() || "./data/acpx-state",
          enabled: true,
        });
        mcpCount = servers.length;
        mcpNames = servers.map((s) => {
          const n = (s as { name?: string }).name;
          return typeof n === "string" ? n : "?";
        });
      } catch {
        /* ignore */
      }
    }

    const acpHost =
      process.env.TACP_ACP_HOST === "1" ||
      process.env.TACP_ACP_HOST === "true";

    await sendInTopic(
      session,
      formatSessionStatus({
        sessionKey: session.sessionKey,
        status: session.status,
        agent,
        launch,
        mode,
        availableModes,
        cwd: session.cwd,
        threadId: session.messageThreadId,
        chatId: session.chatId,
        mcpEnabled,
        mcpCount,
        mcpNames,
        acpHost,
      }),
      undefined,
      { html: true },
    );
  }

  async function handleModeCallback(
    data: string,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    const parsed = parseModeCallback(data);
    if (!parsed) return;

    const pick = modePicks.get(parsed.token);
    if (!pick) {
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Picker expired — run /mode again",
        });
      } catch {
        /* ignore */
      }
      return;
    }

    const session = sessionIndex.byKey[pick.sessionKey];
    if (!session) {
      modePicks.delete(parsed.token);
      return;
    }

    if (parsed.modeIndex === -1) {
      modePicks.delete(parsed.token);
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Cancelled",
        });
      } catch {
        /* ignore */
      }
      if (message) {
        try {
          await env.telegram.editMessageText({
            chatId: message.chat.id,
            messageId: message.message_id,
            text: "Mode picker cancelled.",
            replyMarkup: { inline_keyboard: [] },
          });
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const modeId = pick.modes[parsed.modeIndex];
    modePicks.delete(parsed.token);
    if (!modeId) {
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Invalid mode",
        });
      } catch {
        /* ignore */
      }
      return;
    }

    try {
      await env.telegram.answerCallbackQuery({
        callbackQueryId,
        text: `→ ${modeId}`,
      });
    } catch {
      /* ignore */
    }

    if (message) {
      try {
        await env.telegram.editMessageText({
          chatId: message.chat.id,
          messageId: message.message_id,
          text: `Setting mode → ${modeId}…`,
          replyMarkup: { inline_keyboard: [] },
        });
      } catch {
        /* ignore */
      }
    }

    await applySessionMode(session, modeId, "/mode picker");
  }

  async function handleTopicMessage(msg: TelegramMessage): Promise<void> {
    const threadId = msg.message_thread_id;
    if (threadId === undefined) {
      await handleRootCommand(msg, messageTextOrCaption(msg));
      return;
    }

    const sessionKey = sessionIndex.byThread[String(threadId)];
    if (!sessionKey) {
      // Orphan / unknown topic — never create sessions here; end /new wizard
      // so lobby free-text later cannot keep spawning topics.
      clearPendingNew("unknown topic message");
      return;
    }
    const session = sessionIndex.byKey[sessionKey];
    if (!session) return;

    // Operator is talking to a live session — leave the /new wizard.
    clearPendingNew("session topic activity");

    const captionOrText = messageTextOrCaption(msg);
    const hasMedia = messageHasMedia(msg);
    if (!captionOrText && !hasMedia) {
      log.debug("topic message empty (no text/media)");
      return;
    }

    // Slash commands: text-only (ignore media for command routing).
    const slash = !hasMedia ? parseSlashCommand(captionOrText) : null;

    // Never forward slash commands to the agent.
    if (slash) {
      if (!isKnownCommand(slash.name)) {
        await sendInTopic(session, unknownCommandMessage("topic"));
        return;
      }
      if (!commandAllowedIn(slash.name, "topic")) {
        await sendInTopic(session, wrongScopeMessage(slash.name, "topic"));
        return;
      }
      if (slash.name === "/cancel") {
        await cancelSessionTurn(session);
        return;
      }
      if (slash.name === "/skills") {
        clearSkillFlow(session.sessionKey, "new /skills");
        await offerSkillPicker(session, slash.args[0]);
        return;
      }
      if (
        slash.name === "/mode" ||
        slash.name === "/plan" ||
        slash.name === "/build"
      ) {
        await handleSessionModeCommand(session, slash.name, slash.args);
        return;
      }
      if (slash.name === "/status") {
        await handleStatusCommand(session);
        return;
      }
      if (slash.name === "/mcp") {
        await handleMcpCommand(session, slash.args);
        return;
      }
      if (slash.name === "/help") {
        await sendInTopic(session, topicHelpText());
        return;
      }
      await sendInTopic(session, unknownCommandMessage("topic"));
      return;
    }

    let agentText = captionOrText;
    let attachments: PromptAttachment[] = [];

    if (hasMedia) {
      try {
        const prepared = await prepareAgentMedia({
          msg,
          telegram: env.telegram,
          sessionCwd: session.cwd,
          speech: env.speech,
          acpMediaAttachments: env.config.acpMediaAttachments === true,
        });
        agentText = prepared.text;
        attachments = prepared.attachments;
        log.info("media prepared", {
          sessionKey: session.sessionKey,
          notes: prepared.notes,
          attachments: attachments.length,
          textLen: agentText.length,
        });
      } catch (err) {
        await sendInTopic(
          session,
          `Could not process media: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }

    if (!agentText.trim() && attachments.length === 0) {
      await sendInTopic(session, "Empty message (no text or usable media).");
      return;
    }

    // After skill button: next free-text/media is the user prompt for that skill.
    const pendingSkill = skillTextPending.get(session.sessionKey);
    if (pendingSkill) {
      skillTextPending.delete(session.sessionKey);
      agentText = composeSkillAgentPrompt({
        skillId: pendingSkill.skill.id,
        skillName: pendingSkill.skill.name,
        skillPath: pendingSkill.skill.path,
        userText: agentText || "[media only]",
      });
      log.info("skill prompt ready", {
        sessionKey: session.sessionKey,
        skillId: pendingSkill.skill.id,
        userTextLen: agentText.length,
      });
      try {
        if (pendingSkill.promptMessageId !== undefined) {
          await env.telegram.editMessageText({
            chatId: session.chatId,
            messageId: pendingSkill.promptMessageId,
            text: formatForTelegram(
              `✓ Skill **${pendingSkill.skill.id}** + prompt sent to agent.`,
            ).text,
            parseMode: "HTML",
            replyMarkup: { inline_keyboard: [] },
          });
        }
      } catch {
        /* ignore */
      }
    }

    log.info("action: start turn", {
      sessionKey: session.sessionKey,
      mode: session.status === "running" ? "steer" : "prompt",
      textLen: agentText.length,
      attachments: attachments.length,
      skillId: pendingSkill?.skill.id,
    });
    const handle = await env.agents.ensureSession(session.identity);
    const ac = new AbortController();
    turnAbort.set(session.sessionKey, ac);

    const turn = await env.agents.runPromptTurn(handle, {
      text: agentText,
      ...(attachments.length > 0 ? { attachments } : {}),
      mode: session.status === "running" ? "steer" : "prompt",
      signal: ac.signal,
    });

    const drain = drainTurn(session, turn.events)
      .catch(async () => {
        try {
          await renameTopic(session, "failed");
        } catch {
          /* ignore */
        }
      })
      .finally(() => {
        drainTasks.delete(session.sessionKey);
        turnAbort.delete(session.sessionKey);
      });
    drainTasks.set(session.sessionKey, drain);
    void turn.done.catch(() => {});
  }

  async function offerSkillPicker(
    session: PersistedSession,
    filterArg?: string,
  ): Promise<void> {
    const roots = skillRootsForSession(session.cwd, env.config.skillRoots);
    const skills = await listSkills(roots);
    const filter = filterArg?.toLowerCase();
    const filtered = filter
      ? skills.filter(
          (s) =>
            s.id.toLowerCase().includes(filter) ||
            s.name.toLowerCase().includes(filter),
        )
      : skills;

    const title = filter
      ? `Skills matching \`${filter}\``
      : `Skills for **${session.sessionKey}**`;

    if (filtered.length === 0) {
      await sendInTopic(
        session,
        formatSkillsList([], { title }),
        undefined,
        { html: true },
      );
      return;
    }

    const token = newToken(6);
    const pick: PendingSkillPick = {
      token,
      sessionKey: session.sessionKey,
      skills: filtered,
      page: 0,
      title,
    };
    skillPicks.set(token, pick);
    log.info("skill picker", {
      sessionKey: session.sessionKey,
      count: filtered.length,
      pages: skillPageCount(filtered.length),
      token,
    });
    const sent = await sendInTopic(
      session,
      formatSkillsList(filtered, {
        title,
        withButtons: true,
        page: 0,
        pageSize: SKILL_PAGE_SIZE,
      }),
      buildSkillsKeyboard(token, filtered, 0),
      { html: true },
    );
    pick.messageId = sent.message_id;
    pick.chatId = session.chatId;
  }

  async function refreshSkillPickerPage(
    pick: PendingSkillPick,
    message?: TelegramMessage,
  ): Promise<void> {
    pick.page = clampSkillPage(pick.page, pick.skills.length);
    const title = pick.title ?? "Skills";
    const text = formatForTelegram(
      formatSkillsList(pick.skills, {
        title,
        withButtons: true,
        page: pick.page,
        pageSize: SKILL_PAGE_SIZE,
      }),
    ).text;
    const keyboard = buildSkillsKeyboard(
      pick.token,
      pick.skills,
      pick.page,
    );
    const chatId = message?.chat.id ?? pick.chatId;
    const messageId = message?.message_id ?? pick.messageId;
    if (chatId === undefined || messageId === undefined) return;
    try {
      await env.telegram.editMessageText({
        chatId,
        messageId,
        text,
        parseMode: "HTML",
        replyMarkup: keyboard,
      });
      pick.chatId = chatId;
      pick.messageId = messageId;
    } catch (err) {
      log.warn("skill page edit failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleSkillCallback(
    data: string,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    const parsed = parseSkillCallback(data);
    if (!parsed) return;

    const pick = skillPicks.get(parsed.token);
    if (!pick) {
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Picker expired — run /skills again",
        });
      } catch {
        /* ignore */
      }
      return;
    }

    const session = sessionIndex.byKey[pick.sessionKey];
    if (!session) {
      skillPicks.delete(parsed.token);
      return;
    }

    // Pagination / cancel (negative indices)
    if (parsed.skillIndex === SKILL_CB.pageInfo) {
      const pages = skillPageCount(pick.skills.length);
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: `Page ${pick.page + 1} of ${pages}`,
        });
      } catch {
        /* ignore */
      }
      return;
    }

    if (parsed.skillIndex === SKILL_CB.prev) {
      pick.page = clampSkillPage(pick.page - 1, pick.skills.length);
      try {
        await env.telegram.answerCallbackQuery({ callbackQueryId });
      } catch {
        /* ignore */
      }
      await refreshSkillPickerPage(pick, message);
      return;
    }

    if (parsed.skillIndex === SKILL_CB.next) {
      pick.page = clampSkillPage(pick.page + 1, pick.skills.length);
      try {
        await env.telegram.answerCallbackQuery({ callbackQueryId });
      } catch {
        /* ignore */
      }
      await refreshSkillPickerPage(pick, message);
      return;
    }

    if (parsed.skillIndex === SKILL_CB.cancel) {
      skillPicks.delete(parsed.token);
      skillTextPending.delete(pick.sessionKey);
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Cancelled",
        });
      } catch {
        /* ignore */
      }
      if (message) {
        try {
          await env.telegram.editMessageText({
            chatId: message.chat.id,
            messageId: message.message_id,
            text: "Skill picker cancelled.",
            replyMarkup: { inline_keyboard: [] },
          });
        } catch {
          /* ignore */
        }
      }
      return;
    }

    try {
      await env.telegram.answerCallbackQuery({
        callbackQueryId,
        text: "OK",
      });
    } catch {
      /* ignore */
    }

    if (parsed.skillIndex < 0) return;

    const skill: SkillInfo | undefined = pick.skills[parsed.skillIndex];
    skillPicks.delete(parsed.token);
    if (!skill) return;

    const promptText = formatForTelegram(
      `**Skill selected:** \`${skill.id}\`\n` +
        `${skill.description.slice(0, 160)}\n\n` +
        "Send your **prompt text** now in this topic.\n" +
        "_(/cancel aborts)_",
    ).text;

    if (message) {
      try {
        await env.telegram.editMessageText({
          chatId: message.chat.id,
          messageId: message.message_id,
          text: promptText,
          parseMode: "HTML",
          replyMarkup: { inline_keyboard: [] },
        });
        skillTextPending.set(pick.sessionKey, {
          sessionKey: pick.sessionKey,
          skill,
          promptMessageId: message.message_id,
        });
        log.info("awaiting skill text", {
          sessionKey: pick.sessionKey,
          skillId: skill.id,
        });
        return;
      } catch {
        /* fall through to send */
      }
    }

    const sent = await sendInTopic(session, promptText, undefined, {
      alreadyHtml: true,
    });
    skillTextPending.set(pick.sessionKey, {
      sessionKey: pick.sessionKey,
      skill,
      promptMessageId: sent.message_id,
    });
    log.info("awaiting skill text", {
      sessionKey: pick.sessionKey,
      skillId: skill.id,
    });
  }

  async function handleCallbackQuery(
    update: TelegramUpdate,
  ): Promise<void> {
    const cq = update.callback_query;
    if (!cq?.data) return;
    const chatId = cq.message?.chat.id;
    if (chatId !== undefined) await ensureOperatorChat(chatId);

    const perm = parsePermissionCallback(cq.data);
    if (perm) {
      await handlePermissionCallback(cq.data, cq.id, cq.message);
      return;
    }

    const elicit = parseElicitationCallback(cq.data);
    if (elicit) {
      await handleElicitationCallback(cq.data, cq.id, cq.message);
      return;
    }

    const ask = parseAskQuestionCallback(cq.data);
    if (ask) {
      await handleAskQuestionCallback(cq.data, cq.id, cq.message);
      return;
    }

    const skill = parseSkillCallback(cq.data);
    if (skill) {
      await handleSkillCallback(cq.data, cq.id, cq.message);
      return;
    }

    const mode = parseModeCallback(cq.data);
    if (mode) {
      await handleModeCallback(cq.data, cq.id, cq.message);
      return;
    }

    const repoIdx = parseNewRepoCallback(cq.data);
    if (repoIdx !== undefined && chatId !== undefined) {
      await handleNewRepoCallback(repoIdx, chatId, cq.id, cq.message);
    }
  }

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const summary = summarizeUpdate(update);
    // Own outbound messages (service/topic events) must not re-enter the core —
    // Ursula/Kyoto same issue: bot id posts empty thread messages.
    if (isBotSelf(update)) {
      log.debug("ignore bot self update", summary);
      return;
    }
    if (!isOperator(senderOf(update))) {
      log.debug("ignore non-operator update", summary);
      return;
    }

    log.info("handle update", summary);
    wirePermissionHandler();

    if (update.callback_query) {
      log.info("action: callback", {
        data: update.callback_query.data,
        from: update.callback_query.from?.id,
      });
      await handleCallbackQuery(update);
      return;
    }

    const msg = update.message ?? update.edited_message;
    if (!msg) return;
    const body = messageTextOrCaption(msg);
    const media = messageHasMedia(msg);
    if (!body && !media) {
      log.debug("ignore update without text/media");
      return;
    }

    await ensureOperatorChat(msg.chat.id);

    // Routing: only *known session* threads are agent topics.
    // Everything else is lobby — including General and orphan topics that
    // Telegram tags with is_topic_message (otherwise /ping from the “/” menu
    // is silently dropped when the operator is not on the mapped session).
    const threadId = msg.message_thread_id;
    const knownSessionKey =
      threadId !== undefined
        ? sessionIndex.byThread[String(threadId)]
        : undefined;

    if (knownSessionKey) {
      log.info("action: topic message", {
        thread: threadId,
        text: body.slice(0, 80),
        media,
        session: knownSessionKey,
      });
      await handleTopicMessage(msg);
      return;
    }

    // Lobby: text commands only (no media → agent).
    if (!body) {
      log.debug("ignore lobby media (open a session topic)");
      return;
    }
    log.info("action: root command", {
      text: body.slice(0, 80),
      chat: msg.chat.id,
      thread: threadId,
      isTopicMessage: msg.is_topic_message === true,
      pendingNew: Boolean(pendingName),
    });
    await handleRootCommand(msg, body);
  }

  async function run(signal?: AbortSignal): Promise<void> {
    log.info("startup: asserting topics enabled");
    await assertTopicsEnabled();
    log.info("startup: topics ok; hydrating store");
    await hydrate();
    try {
      log.info("startup: syncing slash menu");
      await syncTelegramSlashMenu(env.telegram, { log, force: true });
    } catch (err) {
      // Menu sync must not block the poll loop — operator can still type /commands.
      log.warn("startup: slash menu sync failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    started = true;
    log.info("startup: poll loop begin", {
      operatorUserId: env.config.operatorUserId,
      operatorChatId,
      sessions: Object.keys(sessionIndex.byKey).length,
    });

    let offset = await loadUpdateOffset(env.store);

    while (!signal?.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await env.telegram.getUpdates({
          offset,
          timeout: pollTimeoutSec,
        });
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof TelegramApiError && err.statusCode === 409) {
          log.warn("getUpdates 409 conflict; backing off", {
            backoffMs: conflictBackoffMs,
          });
          try {
            await env.clock.sleep(conflictBackoffMs, signal);
          } catch {
            return;
          }
          continue;
        }
        log.warn("getUpdates error; backing off", {
          error: err instanceof Error ? err.message : String(err),
          backoffMs: conflictBackoffMs,
        });
        try {
          await env.clock.sleep(conflictBackoffMs, signal);
        } catch {
          return;
        }
        continue;
      }

      if (updates.length === 0) {
        try {
          await env.clock.sleep(conflictBackoffMs, signal);
        } catch {
          return;
        }
        continue;
      }

      for (const update of updates) {
        if (signal?.aborted) return;
        try {
          await handleUpdate(update);
        } catch (err) {
          log.error("handleUpdate error", {
            update_id: update.update_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        offset = update.update_id + 1;
        await saveUpdateOffset(env.store, offset);
        log.debug("acked update offset", { offset });
      }
        // Deliver MCP telegram/speak jobs even when Telegram is idle.
        await drainTelegramQueue();
        await drainSpeakQueue();
    }
  }

  return {
    run: async (signal) => run(signal),
    handleUpdate: async (update) => {
      if (!started) {
        await hydrate();
        started = true;
      }
      return handleUpdate(update);
    },
    listSessions: async () => {
      if (!started) {
        await hydrate();
        started = true;
      }
      return listSessions();
    },
    createSession: async (identity) => {
      if (!started) {
        await hydrate();
        started = true;
      }
      return createSession(identity);
    },
  };
}

export async function assertReadyToRun(env: Environment): Promise<void> {
  const me = await env.telegram.getMe();
  if (!me.has_topics_enabled) {
    throw new TopicsDisabledError();
  }
}
