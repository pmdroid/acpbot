import type {
  Environment,
  MessageReactionUpdated,
  PermissionDecision,
  PermissionRequest,
  SessionIdentity,
  SessionStatus,
  TelegramMessage,
  TelegramUpdate,
} from "../env/types";
import { TelegramApiError } from "../env/types";
import { silentLogger, summarizeUpdate } from "../env/logger";
import { createOutboundMessageIndex } from "./outbound-messages";
import {
  formatTelegramReactionPrompt,
  reactionSetChanged,
} from "./telegram-reactions";
import {
  buildAskQuestionUi,
  createAskUserQuestionBroker,
  newAskToken,
  parseAskUserQuestions,
  toAskUserQuestionExtResponse,
  type AskUserQuestionBroker,
} from "./ask-user-question";
import {
  COMPUTER_CB,
  encodeAgentCallback,
  encodeComputerCallback,
  encodeEffortCallback,
  encodeModeCallback,
  encodeModelCallback,
  encodeEveAskCallback,
  encodeNewRepoCallback,
  encodePermissionModeCallback,
  encodeQueueRemoveCallback,
  keyboardFromButtons,
  newToken,
  parseAgentCallback,
  parseAskQuestionCallback,
  parseComputerCallback,
  parseEffortCallback,
  parseEveAskCallback,
  parseElicitationCallback,
  parseModeCallback,
  parseModelCallback,
  parseNewRepoCallback,
  parsePermissionCallback,
  parsePermissionModeCallback,
  parseQueueRemoveCallback,
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
import { isPlanExitPermission } from "../acp/permission-map";
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
} from "./media";
import { createWorkerApiServer } from "./worker-api-server";
import { awaitInlineDecision } from "./inline-decision";
import { createTurnRunner } from "./turn-runner";
import { createWorkingStatus } from "./working-status";

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
import { initialTopicName, topicName } from "./status";
import {
  formatComputerGrantBanner,
  formatComputerStatusLine,
  formatModeStatus,
  formatSessionStatus,
  resolveBuildModeId,
  resolveModeToken,
  resolvePlanModeId,
  togglePlanBuildModeId,
} from "../acp/session-mode";
import {
  COMPUTER_GRANT_TTL_MS,
  type ComputerFrameEvent,
} from "../acp-host/protocol";
import { resolveHostId } from "../acp-host/hosts";
import { TELEGRAM_PHOTO_MAX_BYTES } from "../mcp/repo-path";
import {
  agentDisplayName,
  listRegisteredAgents,
  normalizeAgentName,
  resolveAgentLaunch,
} from "../acp/agent-launch";
import {
  runReviewPanel,
  type ReviewProtocol,
} from "./review-panel";
import type { ReviewPriority } from "./review-schema";
import {
  currentModelLabel,
  findEffortConfigOption,
  findModelConfigOption,
  formatEffortStatus,
  formatModelStatus,
  type SessionConfigOptionView,
} from "../acp/session-config";
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
  clearMcpProxyAttachPending,
  deleteOAuthToken,
  listOAuthTokenIds,
  markMcpProxyAttachPending,
  remoteIdsNeedingProxyAttach,
  repoKeyForOAuth,
  resolveOAuthStateDir,
} from "../mcp/oauth-store";
import { LINEAR_MCP, LINEAR_MCP_ID } from "../mcp/known-remotes";
import {
  deleteLinearBinding,
  formatLinearBindingLine,
  formatLinearSessionListLabel,
  formatLinearTopicTitle,
  loadLinearBinding,
  parseLinearProjectRef,
  saveLinearBinding,
} from "../linear/bindings";
import {
  applyLinearTurnContext,
  LINEAR_COMMAND_USAGE,
  linearDrainPrompt,
  linearExportPrompt,
  linearFanoutPrompt,
  linearNextPrompt,
  linearProjectPickPrompt,
  linearWorkPrompt,
} from "../linear/prompts";
import {
  issuePairingCode,
  pairingMessageForUser,
  takeAppliedPairing,
  loadPairedOperator,
  takePairingCleared,
} from "./pairing";
import {
  agentSpawn as runAgentSpawn,
  agentList as runAgentList,
  agentKill as runAgentKill,
  agentClose as runAgentClose,
  agentMarkRestored,
  agentSend as runAgentSend,
  agentWait as runAgentWait,
  listIdleCloseableChildren,
  markChildResult,
} from "./agent-spawn";
import { EVE_TAGLINE } from "../eve/types";
import {
  createAcpHostClient,
  resolveAcpHostSockPath,
} from "../acp-host/client";
import {
  formatSpawnAge,
  listChildren,
  loadSpawnIndex,
  resolveAgentTarget,
} from "./agent-spawn-registry";
import type { PermissionMode, PromptAttachment } from "../env/types";
import {
  formatPermissionStatus,
  parsePermissionMode,
  permissionModeLabel,
  PERMISSION_MODE_OPTIONS,
} from "../acp/permission-mode";
import { writePermissionModeToConfig } from "../setup/permission-toml";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type DaemonOptions = {
  pollTimeoutSec?: number;
  conflictBackoffMs?: number;
  /**
   * Absolute (or resolvable) state dir — **must match acp-host**
   * `TACP_STATE_DIR` so OAuth pending/tokens are shared across processes.
   */
  stateDir?: string;
  /**
   * Path to config.toml (optional; operator pairing uses state_dir only).
   */
  configPath?: string;
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
  const stateDir = resolveOAuthStateDir(options.stateDir);
  const configPath = options.configPath;
  const permissionDefaultPath = join(stateDir, "permission-mode.json");

  let sessionIndex: SessionIndex = emptySessionIndex();
  let operatorChatId: number | undefined = env.config.operatorChatId;
  let started = false;
  let permissionWired = false;
  /**
   * Runtime default for **new** topics (overrides config until restart if
   * written via /permissions default). Loaded from state_dir file.
   */
  let runtimePermissionDefault: PermissionMode | undefined;

  const drainTasks = new Map<string, Promise<void>>();
  const turnAbort = new Map<string, AbortController>();
  /**
   * Operator prompts waiting while a turn is in flight for the same session.
   * FIFO after turn end (non-interrupt). /steer interrupts instead.
   * /cancel clears the queue. Remove via button or /unqueue.
   */
  type QueuedTopicPrompt = {
    id: string;
    text: string;
    attachments: PromptAttachment[];
    kind: "prompt" | "steer";
    /**
     * Bot "📥 Queued…" ack message id.
     * Edited on Remove / /unqueue; deleted when the item is dequeued to run.
     */
    botMessageId?: number;
  };
  const promptQueues = new Map<string, QueuedTopicPrompt[]>();
  /** queue item id → sessionKey (for Remove callback). */
  const queueItemSessions = new Map<string, string>();
  /**
   * When set, the next drain finally must NOT pump the queue (steer is about
   * to start a turn immediately after interrupt).
   */
  const skipQueuePump = new Set<string>();
  const MAX_PROMPT_QUEUE = 32;
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
  /** Model picker: token → configId + values */
  const modelPicks = new Map<
    string,
    {
      sessionKey: string;
      configId: string;
      values: Array<{ value: string; name?: string }>;
    }
  >();
  /** Effort picker: token → configId + values */
  const effortPicks = new Map<
    string,
    {
      sessionKey: string;
      configId: string;
      values: Array<{ value: string; name?: string }>;
    }
  >();
  /** Agent binary picker */
  const agentPicks = new Map<
    string,
    { sessionKey: string; agents: string[] }
  >();
  /**
   * Permission policy picker (ask|bypass).
   * - topic: set this session's permissionMode
   * - lobby / default: set runtime default + config.toml
   */
  const permissionModePicks = new Map<
    string,
    {
      scope: "topic" | "default";
      sessionKey?: string;
      /** chatId for lobby replies when no session */
      chatId?: number;
    }
  >();
  /** Computer grant buttons: token → session. */
  const computerPicks = new Map<string, { sessionKey: string }>();
  /** Sessions that sent computer_grant on this worker process (host grant is conn-bound). */
  const computerBound = new Set<string>();
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
    userId !== undefined &&
    env.config.operatorUserId > 0 &&
    userId === env.config.operatorUserId;

  /**
   * Unpaired → issue a pairing code for CLI approve (`acpbot pair approve <code>`).
   */
  async function issuePairingForUser(
    userId: number,
    chatId: number,
    from?: { username?: string; first_name?: string },
  ): Promise<void> {
    if (env.config.operatorUserId > 0) return;
    try {
      const pending = await issuePairingCode(stateDir, {
        userId,
        chatId,
        username: from?.username,
        firstName: from?.first_name,
      });
      log.info("pairing code issued", {
        userId,
        chatId,
        code: pending.code,
        expiresAt: pending.expiresAt,
      });
      await env.telegram.sendMessage({
        chatId,
        text: pairingMessageForUser(pending),
        parseMode: "HTML",
      });
    } catch (err) {
      log.warn("pairing code issue failed", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await env.telegram.sendMessage({
          chatId,
          text:
            "Could not create a pairing code. Check worker logs / state_dir permissions.",
        });
      } catch {
        /* ignore */
      }
    }
  }

  /** Apply CLI `acpbot pair approve` if present (no restart required). */
  async function applyCliPairingIfAny(): Promise<boolean> {
    // Explicit unpair from `acpbot pair clear` (do not wipe test-injected operators).
    if (await takePairingCleared(stateDir)) {
      if (env.config.operatorUserId > 0) {
        log.info("operator unpaired via CLI clear", {
          previous: env.config.operatorUserId,
        });
      }
      env.config.operatorUserId = 0;
    }

    // Durable operator from state (CLI approve or previous session).
    const durable = await loadPairedOperator(stateDir);
    if (durable && durable.userId > 0 && env.config.operatorUserId !== durable.userId) {
      env.config.operatorUserId = durable.userId;
      if (durable.chatId !== undefined) {
        await ensureOperatorChat(durable.chatId);
      }
    }

    const applied = await takeAppliedPairing(stateDir);
    if (!applied) {
      return env.config.operatorUserId > 0;
    }
    env.config.operatorUserId = applied.userId;
    await ensureOperatorChat(applied.chatId);
    log.info("operator claimed via CLI pair approve", {
      userId: applied.userId,
      chatId: applied.chatId,
      code: applied.code,
    });
    try {
      await env.telegram.sendMessage({
        chatId: applied.chatId,
        text:
          `✅ Pairing approved on the host.\n` +
          `You're the acpbot operator (user id <code>${applied.userId}</code>).\n` +
          `Only this account can control the bot.\n` +
          `Try /ping or /new.`,
        parseMode: "HTML",
      });
    } catch {
      /* ignore */
    }
    return true;
  }

  /** Survives worker restart so reactions still map message_id → session. */
  const outboundMessagesPath = join(stateDir, "outbound-messages.json");
  let outboundSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleOutboundSave = () => {
    if (outboundSaveTimer) clearTimeout(outboundSaveTimer);
    outboundSaveTimer = setTimeout(() => {
      outboundSaveTimer = undefined;
      void outboundMessages.saveFile(outboundMessagesPath).catch((err) => {
        log.warn("outbound message index save failed", {
          path: outboundMessagesPath,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 400);
  };
  const outboundMessages = createOutboundMessageIndex({
    onChange: scheduleOutboundSave,
  });

  const senderOf = (update: TelegramUpdate): number | undefined => {
    if (update.message?.from?.id !== undefined) return update.message.from.id;
    if (update.callback_query?.from?.id !== undefined) {
      return update.callback_query.from.id;
    }
    if (update.edited_message?.from?.id !== undefined) {
      return update.edited_message.from.id;
    }
    if (update.message_reaction?.user?.id !== undefined) {
      return update.message_reaction.user.id;
    }
    return undefined;
  };

  const isBotSelf = (update: TelegramUpdate): boolean => {
    const from =
      update.message?.from ??
      update.edited_message?.from ??
      update.callback_query?.from ??
      update.message_reaction?.user;
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
    await loadRuntimePermissionDefault();
    try {
      const { loaded } = await outboundMessages.loadFile(outboundMessagesPath);
      if (loaded > 0) {
        log.info("outbound message index loaded", {
          path: outboundMessagesPath,
          entries: loaded,
        });
      }
    } catch (err) {
      log.warn("outbound message index load failed", {
        path: outboundMessagesPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Naming mode is never durable — process start/restart always exits it.
    clearPendingNew("hydrate/restart");
    wirePermissionHandler();
    wireComputerHandlers();
    for (const session of Object.values(sessionIndex.byKey)) {
      await syncComputerGrant(session).catch((err) => {
        log.warn("computer grant hydrate rebind failed", {
          sessionKey: session.sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
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

  /**
   * Persist session status only. Topic titles are never rewritten for status —
   * the live working bubble carries “working / waiting” instead.
   */
  async function setSessionStatus(
    session: PersistedSession,
    status: SessionStatus,
  ): Promise<void> {
    session.status = status;
    session.updatedAt = env.clock.now();
    sessionIndex.byKey[session.sessionKey] = session;
    await persistIndex();
  }

  function currentComputerHostId(session: PersistedSession): string {
    const catalog = env.config.hostsCatalog;
    if (!catalog) return "local";
    return resolveHostId({
      repoKey: session.identity.repo,
      catalog,
    });
  }

  function liveComputerGrant(
    session: PersistedSession,
  ): PersistedSession["computerGrant"] {
    const g = session.computerGrant;
    if (!g?.enabled) return undefined;
    if (g.expiresAt > 0 && env.clock.now() >= g.expiresAt) return undefined;
    return g;
  }

  async function revokeComputerGrant(
    session: PersistedSession,
  ): Promise<boolean> {
    const grant = session.computerGrant;
    if (!grant) return false;
    const hostId = grant.hostId;
    delete session.computerGrant;
    computerBound.delete(session.sessionKey);
    session.updatedAt = env.clock.now();
    sessionIndex.byKey[session.sessionKey] = session;
    await persistIndex();
    if (env.agents.computerAbort) {
      await env.agents
        .computerAbort(session.sessionKey, { hostId })
        .catch(() => {});
    }
    return grant.enabled;
  }

  async function expireComputerGrantIfNeeded(
    session: PersistedSession,
  ): Promise<void> {
    if (session.computerGrant && !liveComputerGrant(session)) {
      await revokeComputerGrant(session);
    }
  }

  async function maybeRevokeComputerGrantIfHostChanged(
    session: PersistedSession,
  ): Promise<void> {
    const g = session.computerGrant;
    if (!g?.enabled) return;
    let hostId: string;
    try {
      hostId = currentComputerHostId(session);
    } catch {
      await revokeComputerGrant(session);
      return;
    }
    if (hostId !== g.hostId) {
      await revokeComputerGrant(session);
    }
  }

  /**
   * Re-send persist on this conn. Host grant dies with the previous socket;
   * persist alone must not look granted.
   */
  async function rebindComputerGrantIfNeeded(
    session: PersistedSession,
  ): Promise<void> {
    const g = liveComputerGrant(session);
    if (!g || computerBound.has(session.sessionKey)) return;
    if (!env.agents.computerGrant) {
      await revokeComputerGrant(session);
      return;
    }
    try {
      await env.agents.computerGrant({
        sessionKey: session.sessionKey,
        grant: {
          enabled: g.enabled,
          watch: g.watch,
          expiresAt: g.expiresAt,
          hostId: g.hostId,
        },
      });
      computerBound.add(session.sessionKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unknown type/i.test(msg)) {
        await revokeComputerGrant(session);
        await sendInTopic(session, "🖥 Computer · host too old").catch(() => {});
        return;
      }
      log.warn("computer grant rebind failed", {
        sessionKey: session.sessionKey,
        error: msg,
      });
    }
  }

  async function syncComputerGrant(
    session: PersistedSession,
  ): Promise<PersistedSession["computerGrant"]> {
    await maybeRevokeComputerGrantIfHostChanged(session);
    await expireComputerGrantIfNeeded(session);
    await rebindComputerGrantIfNeeded(session);
    const live = liveComputerGrant(session);
    if (!live || !computerBound.has(session.sessionKey)) return undefined;
    return live;
  }

  function computerKeyboard(token: string) {
    return keyboardFromButtons([
      { text: "Enable", callback_data: encodeComputerCallback(token, COMPUTER_CB.on) },
      { text: "Watch", callback_data: encodeComputerCallback(token, COMPUTER_CB.watch) },
      { text: "Stop", callback_data: encodeComputerCallback(token, COMPUTER_CB.off) },
    ]);
  }

  function getDefaultPermissionMode(): PermissionMode {
    return (
      runtimePermissionDefault ??
      env.config.permissionMode ??
      "ask"
    );
  }

  function effectivePermissionMode(
    session?: PersistedSession,
  ): PermissionMode {
    if (!session) return getDefaultPermissionMode();
    // Headless (and all) children inherit the parent's ask/bypass policy.
    if (session.parentSessionKey) {
      const parent = sessionIndex.byKey[session.parentSessionKey];
      if (parent) {
        return parent.permissionMode ?? getDefaultPermissionMode();
      }
    }
    return session.permissionMode ?? getDefaultPermissionMode();
  }

  /** Leaf slug from child session key (e.g. work/plan--impl → impl). */
  function childSlugOf(sessionKey: string): string {
    return sessionKey.includes("--")
      ? sessionKey.split("--").slice(-1)[0]!
      : sessionKey;
  }

  /**
   * Where operator-facing UI goes: headless children surface on the parent topic.
   */
  function resolveOperatorSurface(
    session: PersistedSession,
  ): PersistedSession {
    if (!session.headless || !session.parentSessionKey) return session;
    return sessionIndex.byKey[session.parentSessionKey] ?? session;
  }

  /** Send text for a session; headless children post on the parent with a prefix. */
  async function sendForSession(
    session: PersistedSession,
    text: string,
    opts?: { html?: boolean },
  ): Promise<void> {
    const surface = resolveOperatorSurface(session);
    const body =
      session.headless && surface.sessionKey !== session.sessionKey
        ? `[${childSlugOf(session.sessionKey)}] ${text}`
        : text;
    await sendInTopic(surface, body, undefined, opts);
  }

  /**
   * Gateway ids already attached as stdio mcp-proxy children for a live slot
   * (including empty/unauthed proxies). Reauth does not clear this.
   * `/mcp add` on a live slot → force-respawn once to spawn the new proxy.
   */
  const attachedMcpProxies = new Map<string, Set<string>>();

  async function registryRemoteIds(repoRoot: string): Promise<string[]> {
    const config = await readMcpConfig(repoRoot);
    return config.mcpServers
      .filter(
        (s) =>
          typeof s.name === "string" &&
          s.name.trim() &&
          typeof s.url === "string" &&
          s.url.trim(),
      )
      .map((s) => String(s.name).trim());
  }

  async function refreshAttachedMcpProxyTracking(
    session: PersistedSession,
  ): Promise<void> {
    const repoRoot = session.cwd;
    const repoKey = repoKeyForOAuth(session.identity.repo, repoRoot);
    const oauthStateDir = resolveOAuthStateDir(stateDir);
    // All remotes are rewritten to proxies at spawn — track registry set,
    // not only those with tokens (empty tools until /mcp auth).
    const remotes = await registryRemoteIds(repoRoot);
    const attached = new Set(remotes);
    attachedMcpProxies.set(session.sessionKey, attached);
    if (attached.size > 0) {
      await clearMcpProxyAttachPending(oauthStateDir, repoKey, [...attached]);
    }
  }

  /**
   * Remotes in the registry that this slot has not yet spawned as mcp-proxy
   * (typical: `/mcp add` while the agent is already running).
   */
  async function sessionNeedsFirstProxyAttach(
    session: PersistedSession,
  ): Promise<string[]> {
    const repoRoot = session.cwd;
    const repoKey = repoKeyForOAuth(session.identity.repo, repoRoot);
    const oauthStateDir = resolveOAuthStateDir(stateDir);
    const remotes = await registryRemoteIds(repoRoot);
    const already =
      attachedMcpProxies.get(session.sessionKey) ?? new Set<string>();
    return remoteIdsNeedingProxyAttach(
      oauthStateDir,
      repoKey,
      remotes,
      already,
    );
  }

  async function ensureSessionWithPerms(
    session: PersistedSession,
    opts?: { forceRespawn?: boolean; forceNewSession?: boolean },
  ) {
    await maybeRestoreClosedChild(session.sessionKey);
    let forceRespawn = opts?.forceRespawn === true;
    const forceNewSession = opts?.forceNewSession === true;
    let firstAttach: string[] = [];
    if (!forceRespawn && !forceNewSession) {
      try {
        firstAttach = await sessionNeedsFirstProxyAttach(session);
        if (firstAttach.length > 0) {
          forceRespawn = true;
          log.info("ensureSession: first-time mcp-proxy attach", {
            sessionKey: session.sessionKey,
            gateways: firstAttach,
          });
        }
      } catch (err) {
        log.warn("ensureSession: attach check failed", {
          sessionKey: session.sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await syncComputerGrant(session);
    const handle = await env.agents.ensureSession(session.identity, {
      permissionMode: effectivePermissionMode(session),
      // Child worktrees store absolute cwd on the session record
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(forceRespawn ? { forceRespawn: true } : {}),
      ...(forceNewSession ? { forceNewSession: true } : {}),
    });
    try {
      await refreshAttachedMcpProxyTracking(session);
    } catch {
      /* non-fatal */
    }
    return handle;
  }

  async function loadRuntimePermissionDefault(): Promise<void> {
    try {
      const raw = await readFile(permissionDefaultPath, "utf8");
      const parsed = JSON.parse(raw) as { permissionMode?: string };
      const m = parsePermissionMode(parsed.permissionMode);
      if (m) runtimePermissionDefault = m;
    } catch {
      /* missing or corrupt — use config */
    }
  }

  async function saveRuntimePermissionDefault(
    mode: PermissionMode,
  ): Promise<void> {
    runtimePermissionDefault = mode;
    // Keep live config in sync so ensure/status use the new default immediately.
    env.config.permissionMode = mode;
    await mkdir(dirname(permissionDefaultPath), { recursive: true });
    await writeFile(
      permissionDefaultPath,
      `${JSON.stringify({ permissionMode: mode }, null, 2)}\n`,
      "utf8",
    );
    // Persist into config.toml so restarts (and config watch) keep the choice.
    if (configPath) {
      try {
        writePermissionModeToConfig(configPath, mode);
        log.info("permission_mode written to config.toml", {
          mode,
          path: configPath,
        });
      } catch (err) {
        log.warn("could not write permission_mode to config.toml", {
          path: configPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Two-button Ask | Bypass keyboard for /permissions. */
  function permissionModeKeyboard(
    token: string,
    current: PermissionMode,
  ): ReturnType<typeof keyboardFromButtons> {
    const buttons = PERMISSION_MODE_OPTIONS.map((opt, i) => ({
      text: (opt.mode === current ? "✓ " : "") + opt.label,
      callback_data: encodePermissionModeCallback(token, i),
    }));
    return keyboardFromButtons(buttons);
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

    const permissionMode = getDefaultPermissionMode();
    const handle = await env.agents.ensureSession(identity, {
      permissionMode,
    });
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
      permissionMode,
      createdAt: now,
      updatedAt: now,
    };

    sessionIndex.byKey[sessionKey] = record;
    sessionIndex.byThread[String(topic.message_thread_id)] = sessionKey;
    await persistIndex();
    log.info("session topic created", {
      sessionKey,
      thread: topic.message_thread_id,
      permissionMode,
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

  /**
   * Assigned after sendInTopic is defined (sendInTopic auto-bumps the ⏳
   * bubble so permanent mid-turn messages do not bury status).
   */
  let working!: ReturnType<typeof createWorkingStatus>;

  async function sendInTopic(
    session: PersistedSession,
    text: string,
    replyMarkup?: unknown,
    opts?: {
      html?: boolean;
      alreadyHtml?: boolean;
      /** When true, this send *is* the working bubble — do not bump after. */
      workingBubble?: boolean;
    },
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
      // Index every chunk (incl. text) so reactions resolve + agent sees content.
      if (last.message_id) {
        outboundMessages.record({
          chatId: session.chatId,
          messageId: last.message_id,
          sessionKey: session.sessionKey,
          messageThreadId: session.messageThreadId,
          kind: replyMarkup !== undefined && isLast ? "ui" : "agent",
          text: chunk,
        });
      }
    }
    // Keep ⏳ as the latest message after permanent mid-turn content.
    // No-op when cleared (final reply) or when this send *is* the bubble.
    if (!opts?.workingBubble && working) {
      try {
        await working.bump(session);
      } catch (err) {
        log.debug("working bump after outbound failed", {
          sessionKey: session.sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return last;
  }

  working = createWorkingStatus({
    telegram: env.telegram,
    sendInTopic,
    log,
  });
  const turns = createTurnRunner({
    env,
    working,
    sendInTopic,
    setSessionStatus,
    log,
  });
  const inlineDecisionDeps = {
    setSessionStatus,
    working,
    sendInTopic,
    telegram: env.telegram,
    log,
  };

  function wireComputerHandlers(): void {
    env.agents.setComputerFrameHandler?.((frame) => {
      void handleComputerFrame(frame);
    });
    env.agents.setComputerStatusHandler?.((status) => {
      void handleComputerStatus(status);
    });
  }

  async function handleComputerFrame(frame: ComputerFrameEvent): Promise<void> {
    const session = sessionIndex.byKey[frame.sessionKey];
    if (!session) return;
    let data: Uint8Array;
    try {
      data = Buffer.from(frame.jpegBase64, "base64");
    } catch {
      log.warn("computer frame invalid base64", {
        sessionKey: frame.sessionKey,
      });
      return;
    }
    if (data.byteLength === 0 || data.byteLength > TELEGRAM_PHOTO_MAX_BYTES) {
      log.warn("computer frame dropped", {
        sessionKey: frame.sessionKey,
        bytes: data.byteLength,
      });
      return;
    }
    if (!env.telegram.sendPhoto) return;
    try {
      await env.telegram.sendPhoto({
        chatId: session.chatId,
        messageThreadId: session.messageThreadId,
        data,
        filename: "computer.jpg",
        ...(frame.caption.trim() ? { caption: frame.caption.trim() } : {}),
      });
      await working.bump(session).catch(() => {});
      env.agents.computerFrameAck?.(frame.sessionKey, frame.frameId);
    } catch (err) {
      log.warn("computer frame telegram failed", {
        sessionKey: frame.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleComputerStatus(status: {
    sessionKey: string;
    text: string;
  }): Promise<void> {
    const session = sessionIndex.byKey[status.sessionKey];
    if (!session || !status.text.trim()) return;
    await sendInTopic(session, status.text).catch((err) => {
      log.warn("computer status telegram failed", {
        sessionKey: status.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
   * Permission UI awaits Telegram on the ACP host hook (not in drainTurn).
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

    const planExit = isPlanExitPermission(req.raw);
    // Tools may bypass; plan-exit always needs a Telegram approve/reject.
    if (effectivePermissionMode(session) === "bypass" && !planExit) {
      log.info("permission auto-approved (bypass)", {
        sessionKey,
        toolCallId: req.toolCallId,
      });
      return { outcome: "allow_always" };
    }
    if (planExit) {
      log.info("plan-exit permission UI (forced ask)", {
        sessionKey,
        toolCallId: req.toolCallId,
        sessionBypass: effectivePermissionMode(session) === "bypass",
      });
    }

    const surface = resolveOperatorSurface(session);
    const ui = buildPermissionUi(req);
    const promptText =
      session.headless && surface.sessionKey !== session.sessionKey
        ? `**[${childSlugOf(sessionKey)}]** needs permission\n\n${ui.text}`
        : ui.text;
    log.info("permission UI: send keyboard", {
      sessionKey,
      surface: surface.sessionKey,
      toolCallId: req.toolCallId,
      token: ui.token,
      options: ui.options.map((o) => o.name),
    });

    const decision = await awaitInlineDecision(inlineDecisionDeps, {
      session: surface,
      signal: ctx.signal,
      waitingBubbleText: "Waiting for your decision…",
      text: promptText,
      keyboard: ui.keyboard,
      sendOpts: { html: true },
      logContext: { kind: "permission", token: ui.token },
      settledAction: "delete",
      onAbort: () => {
        permissions.cancelAllForSession(sessionKey, { outcome: "cancel" });
      },
      onAbortResult: { outcome: "cancel" as const },
      register: ({ messageId, resolve }) => {
        permissions.register({
          token: ui.token,
          // Child owns the turn; surface is display-only
          sessionKey,
          chatId: surface.chatId,
          messageThreadId: surface.messageThreadId,
          messageId,
          options: ui.options,
          promptText,
          settled: false,
          resolve,
        });
      },
      formatSettled: (d) => {
        // Unused when settledAction is delete; kept for type completeness.
        return { text: d.outcome };
      },
    });

    log.info("permission UI: settled", {
      sessionKey,
      decision: decision.outcome,
    });
    return decision;
  }

  async function handlePermissionCallback(
    data: string,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    const parsed = parsePermissionCallback(data);
    if (!parsed) return;

    const decision = permissions.settle(parsed.token, parsed.optionIndex);

    // Permission prompts are deleted by awaitInlineDecision after settle.
    // Best-effort answer so Telegram stops the loading spinner.
    try {
      await env.telegram.answerCallbackQuery({
        callbackQueryId,
        text: decision ? "Recorded" : "Already answered",
      });
    } catch {
      /* ignore */
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

    const surface = resolveOperatorSurface(session);
    const ui = buildElicitationUi({ sessionId: sessionKey, raw: req.raw });
    const elicitText =
      session.headless && surface.sessionKey !== session.sessionKey
        ? `**[${childSlugOf(sessionKey)}]**\n\n${ui.text}`
        : ui.text;
    log.info("elicitation UI: send keyboard", {
      sessionKey,
      surface: surface.sessionKey,
      token: ui.token,
      options: ui.options.map((o) => o.label),
    });

    const decision = await awaitInlineDecision(inlineDecisionDeps, {
      session: surface,
      signal: ctx.signal,
      waitingBubbleText: "Waiting for your answer…",
      text: elicitText,
      keyboard: ui.keyboard,
      sendOpts: { alreadyHtml: true },
      logContext: { kind: "elicitation", token: ui.token },
      onAbort: () => {
        elicitations.cancelAllForSession(sessionKey);
      },
      onAbortResult: { action: "cancel" as const },
      register: ({ messageId, resolve }) => {
        elicitations.register({
          token: ui.token,
          sessionKey,
          chatId: surface.chatId,
          messageThreadId: surface.messageThreadId,
          messageId,
          fieldName: ui.fieldName,
          options: ui.options,
          promptText: elicitText,
          settled: false,
          resolve,
        });
      },
      formatSettled: (d) => {
        const summary =
          d.action === "accept"
            ? `→ chose: ${JSON.stringify(d.content)}`
            : `→ ${d.action}`;
        return { text: `${elicitText}\n\n${summary}`, parseMode: "HTML" };
      },
    });

    log.info("elicitation UI: settled", { sessionKey, decision });
    return decision;
  }

  /**
   * Grok `_x.ai/ask_user_question` → sequential multi-choice Telegram keyboards.
   * Multi-step progress edits stay in the callback handler; only the wait shell is shared.
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

    const surface = resolveOperatorSurface(session);
    const questions = parseAskUserQuestions(req.raw);
    if (questions.length === 0) {
      log.warn("ask_user_question empty questions", { sessionKey });
      return toAskUserQuestionExtResponse({ answers: [] }, { declined: true });
    }

    const token = newAskToken();
    const first = buildAskQuestionUi(token, 0, questions.length, questions[0]!);
    const askPrefix =
      session.headless && surface.sessionKey !== session.sessionKey
        ? `**[${childSlugOf(sessionKey)}]**\n\n`
        : "";
    log.info("ask_user_question UI", {
      sessionKey,
      token,
      count: questions.length,
      first: questions[0]?.question.slice(0, 80),
    });

    type AskResult = {
      answers: Array<{
        question: string;
        header?: string;
        selectedOptions: string[];
      }>;
    };

    const emptyAnswers: AskResult = {
      answers: questions.map((q) => ({
        question: q.question,
        header: q.header,
        selectedOptions: [] as string[],
      })),
    };

    const result = await awaitInlineDecision(inlineDecisionDeps, {
      session: surface,
      signal: ctx.signal,
      waitingBubbleText: "Waiting for your answer…",
      text: askPrefix + first.text,
      keyboard: first.keyboard,
      sendOpts: { alreadyHtml: true },
      logContext: { kind: "ask_user_question", token },
      onAbort: () => {
        askQuestions.cancelAllForSession(sessionKey);
      },
      onAbortResult: emptyAnswers,
      register: ({ messageId, resolve }) => {
        askQuestions.register({
          token,
          sessionKey,
          chatId: surface.chatId,
          messageThreadId: surface.messageThreadId,
          questions,
          answers: questions.map(() => []),
          currentIndex: 0,
          messageId,
          selected: new Set(),
          settled: false,
          resolve,
        });
      },
      formatSettled: (r) => {
        const summary = r.answers
          .map(
            (a) =>
              `• ${a.question.slice(0, 60)} → ${a.selectedOptions.join(", ") || "(skipped)"}`,
          )
          .join("\n");
        return {
          text: formatForTelegram(`**Answers recorded**\n\n${summary}`).text,
          parseMode: "HTML",
        };
      },
    });

    const wire = toAskUserQuestionExtResponse(result);
    log.info("ask_user_question settled", {
      sessionKey,
      answers: result.answers,
      wireOutcome: wire.outcome,
    });
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
      case "/permissions":
        await handlePermissionsCommand(slash.args, {
          scope: "lobby",
          chatId,
          reply: (text, replyMarkup, extra) =>
            lobbyReply(text, replyMarkup, extra),
        });
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
        const lines: string[] = [];
        for (const s of sessions) {
          let linearLabel: string | undefined;
          try {
            const b = await loadLinearBinding(stateDir, s.sessionKey);
            linearLabel = formatLinearSessionListLabel(b);
          } catch {
            /* ignore */
          }
          const base = `${topicName(s.identity.repo, s.identity.name)} · ${s.status}  (thread ${s.messageThreadId})`;
          lines.push(linearLabel ? `${base}\n  ${linearLabel}` : base);
        }
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

  function sessionTurnBusy(sessionKey: string): boolean {
    return drainTasks.has(sessionKey) || turnAbort.has(sessionKey);
  }

  function clearPromptQueue(sessionKey: string): number {
    const q = promptQueues.get(sessionKey) ?? [];
    for (const item of q) queueItemSessions.delete(item.id);
    promptQueues.delete(sessionKey);
    return q.length;
  }

  function enqueueTopicPrompt(
    sessionKey: string,
    item: Omit<QueuedTopicPrompt, "id"> & { id?: string },
    opts?: { front?: boolean },
  ): { item: QueuedTopicPrompt; depth: number; dropped: boolean } {
    let q = promptQueues.get(sessionKey);
    if (!q) {
      q = [];
      promptQueues.set(sessionKey, q);
    }
    let dropped = false;
    if (q.length >= MAX_PROMPT_QUEUE) {
      const old = q.shift();
      if (old) queueItemSessions.delete(old.id);
      dropped = true;
    }
    const full: QueuedTopicPrompt = {
      id: item.id ?? newToken(),
      text: item.text,
      attachments: item.attachments,
      kind: item.kind ?? "prompt",
      ...(item.botMessageId !== undefined
        ? { botMessageId: item.botMessageId }
        : {}),
    };
    if (opts?.front) q.unshift(full);
    else q.push(full);
    queueItemSessions.set(full.id, sessionKey);
    return { item: full, depth: q.length, dropped };
  }

  function removeQueuedById(
    sessionKey: string,
    id: string,
  ): QueuedTopicPrompt | undefined {
    const q = promptQueues.get(sessionKey);
    if (!q) return undefined;
    const idx = q.findIndex((x) => x.id === id);
    if (idx < 0) return undefined;
    const [removed] = q.splice(idx, 1);
    queueItemSessions.delete(id);
    if (q.length === 0) promptQueues.delete(sessionKey);
    return removed;
  }

  function removeQueuedByIndex(
    sessionKey: string,
    index1Based: number,
  ): QueuedTopicPrompt | undefined {
    const q = promptQueues.get(sessionKey);
    if (!q || index1Based < 1 || index1Based > q.length) return undefined;
    const [removed] = q.splice(index1Based - 1, 1);
    queueItemSessions.delete(removed!.id);
    if (q.length === 0) promptQueues.delete(sessionKey);
    return removed;
  }

  function formatQueueList(sessionKey: string): string {
    const q = promptQueues.get(sessionKey) ?? [];
    if (q.length === 0) {
      return "Queue empty. Free-text while a turn runs is queued (non-interrupt). Use `/steer <text>` to interrupt.";
    }
    const lines = [
      `**Queue** (${q.length}) — runs after the current turn ends:`,
      "",
    ];
    q.forEach((item, i) => {
      const tag = item.kind === "steer" ? "steer" : "msg";
      const preview = item.text.replace(/\s+/g, " ").slice(0, 80);
      lines.push(`${i + 1}. \`[${tag}]\` ${preview}${item.text.length > 80 ? "…" : ""}`);
    });
    lines.push(
      "",
      "Remove: button on the queue ack · `/unqueue` · `/unqueue <n>` · `/unqueue all`",
    );
    return lines.join("\n");
  }

  /**
   * Abort in-flight turn without clearing the prompt queue.
   * Sets skipQueuePump so the cancelled drain's finally does not dequeue
   * free-text before the caller starts a steer turn.
   */
  async function interruptCurrentTurn(
    session: PersistedSession,
    reason: string,
  ): Promise<void> {
    const key = session.sessionKey;
    skipQueuePump.add(key);
    const pending = drainTasks.get(key);
    const ac = turnAbort.get(key);
    ac?.abort();
    turnAbort.delete(key);
    if (env.agents.cancelTurn) {
      await env.agents.cancelTurn(key, reason).catch(() => {});
    }
    if (pending) await pending.catch(() => {});
    // Ensure flags clear even if drain never registered
    drainTasks.delete(key);
    turnAbort.delete(key);
    // Drain finally consumes skipQueuePump; clear leftover if no drain ran.
    skipQueuePump.delete(key);
    await working.clear(session).catch(() => {});
  }

  function maybePumpAfterTurn(sessionKey: string): void {
    if (skipQueuePump.has(sessionKey)) {
      skipQueuePump.delete(sessionKey);
      return;
    }
    void pumpPromptQueue(sessionKey);
  }

  async function markQueueAckRemoved(
    session: PersistedSession,
    item: QueuedTopicPrompt,
    note?: string,
  ): Promise<void> {
    if (item.botMessageId === undefined) return;
    const preview = item.text.replace(/\s+/g, " ").slice(0, 60);
    const body = formatForTelegram(
      note ??
        `🗑 Removed from queue: ${preview}${item.text.length > 60 ? "…" : ""}`,
    );
    try {
      await env.telegram.editMessageText({
        chatId: session.chatId,
        messageId: item.botMessageId,
        text: body.text,
        parseMode: body.parseMode,
        replyMarkup: { inline_keyboard: [] },
      });
    } catch {
      /* ignore — message may be gone */
    }
  }

  /** Remove the "📥 Queued…" ack from chat when the item starts running. */
  async function deleteQueueAck(
    session: PersistedSession,
    item: QueuedTopicPrompt,
  ): Promise<void> {
    if (item.botMessageId === undefined) return;
    try {
      await env.telegram.deleteMessage({
        chatId: session.chatId,
        messageId: item.botMessageId,
      });
    } catch {
      /* ignore — message may already be gone */
    }
  }

  async function handleQueueCommand(session: PersistedSession): Promise<void> {
    await sendInTopic(session, formatQueueList(session.sessionKey), undefined, {
      html: true,
    });
  }

  async function handleUnqueueCommand(
    session: PersistedSession,
    args: string[],
  ): Promise<void> {
    const key = session.sessionKey;
    const q = promptQueues.get(key) ?? [];
    if (q.length === 0) {
      await sendInTopic(session, "Queue is empty — nothing to remove.");
      return;
    }
    const raw = (args[0] ?? "").trim().toLowerCase();
    if (raw === "all") {
      const n = clearPromptQueue(key);
      await sendInTopic(
        session,
        `🗑 Cleared ${n} queued message${n === 1 ? "" : "s"}.`,
      );
      return;
    }
    let removed: QueuedTopicPrompt | undefined;
    if (raw === "" || raw === "last") {
      removed = removeQueuedByIndex(key, q.length);
    } else if (/^\d+$/.test(raw)) {
      removed = removeQueuedByIndex(key, Number(raw));
      if (!removed) {
        await sendInTopic(
          session,
          `No queue item #${raw}. Use \`/queue\` to list.`,
          undefined,
          { html: true },
        );
        return;
      }
    } else {
      await sendInTopic(
        session,
        "Usage: `/unqueue` · `/unqueue <n>` · `/unqueue all`",
        undefined,
        { html: true },
      );
      return;
    }
    if (removed) {
      await markQueueAckRemoved(session, removed);
      await sendInTopic(
        session,
        `🗑 Removed from queue (${promptQueues.get(key)?.length ?? 0} left).`,
      );
    }
  }

  async function handleSteerCommand(
    session: PersistedSession,
    args: string[],
  ): Promise<void> {
    const text = args.join(" ").trim();
    if (!text) {
      await sendInTopic(
        session,
        "Usage: `/steer <guidance>` — interrupts the current turn.",
        undefined,
        { html: true },
      );
      return;
    }
    log.info("action: /steer", {
      sessionKey: session.sessionKey,
      busy: sessionTurnBusy(session.sessionKey),
      textLen: text.length,
    });
    if (sessionTurnBusy(session.sessionKey)) {
      await sendInTopic(session, "🎯 Steering…", undefined, { html: true });
      await interruptCurrentTurn(session, "operator /steer");
    }
    await beginTopicTurn(session, text, []);
  }

  async function handleQueueRemoveCallback(
    data: string,
    callbackQueryId: string,
    message: TelegramMessage | undefined,
  ): Promise<void> {
    const token = parseQueueRemoveCallback(data);
    if (!token) return;
    const sessionKey = queueItemSessions.get(token);
    if (!sessionKey) {
      await env.telegram.answerCallbackQuery({
        callbackQueryId,
        text: "Already removed or expired",
        showAlert: false,
      }).catch(() => {});
      if (message?.message_id !== undefined && message.chat?.id !== undefined) {
        try {
          await env.telegram.editMessageText({
            chatId: message.chat.id,
            messageId: message.message_id,
            text: "🗑 Already removed from queue.",
            replyMarkup: { inline_keyboard: [] },
          });
        } catch {
          /* ignore */
        }
      }
      return;
    }
    const session = sessionIndex.byKey[sessionKey];
    const removed = removeQueuedById(sessionKey, token);
    await env.telegram.answerCallbackQuery({
      callbackQueryId,
      text: removed ? "Removed from queue" : "Already removed",
      showAlert: false,
    }).catch(() => {});
    if (removed && session) {
      await markQueueAckRemoved(session, {
        ...removed,
        botMessageId: removed.botMessageId ?? message?.message_id,
      });
    } else if (message?.message_id !== undefined && message.chat?.id !== undefined) {
      try {
        await env.telegram.editMessageText({
          chatId: message.chat.id,
          messageId: message.message_id,
          text: "🗑 Removed from queue.",
          replyMarkup: { inline_keyboard: [] },
        });
      } catch {
        /* ignore */
      }
    }
  }

  async function cancelSessionTurn(session: PersistedSession): Promise<void> {
    log.info("action: /cancel", { sessionKey: session.sessionKey });
    clearSkillFlow(session.sessionKey, "/cancel");
    const queued = clearPromptQueue(session.sessionKey);
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
    const revoked = await revokeComputerGrant(session);
    await working.clear(session);
    await setSessionStatus(session, "idle");
    const extra =
      queued > 0
        ? ` · cleared ${queued} queued message${queued === 1 ? "" : "s"}`
        : "";
    const grantNote = revoked ? " — computer grant revoked" : " — session kept";
    await sendInTopic(
      session,
      `⏹ turn cancelled${grantNote}${extra}`,
      undefined,
      { html: true },
    );
  }

  /**
   * Topic `/fresh` (alias `/reset`): cancel turn + queue, then session/new
   * with no history resume. Telegram topic + repo/name mapping stay.
   */
  async function handleFreshCommand(session: PersistedSession): Promise<void> {
    log.info("action: /fresh", { sessionKey: session.sessionKey });
    clearSkillFlow(session.sessionKey, "/fresh");
    const queued = clearPromptQueue(session.sessionKey);
    permissions.cancelAllForSession(session.sessionKey, {
      outcome: "cancel",
    });
    elicitations.cancelAllForSession(session.sessionKey);
    askQuestions.cancelAllForSession(session.sessionKey);
    const ac = turnAbort.get(session.sessionKey);
    ac?.abort();
    turnAbort.delete(session.sessionKey);
    if (env.agents.cancelTurn) {
      try {
        await env.agents.cancelTurn(session.sessionKey, "operator /fresh");
      } catch {
        /* */
      }
    }
    const revoked = await revokeComputerGrant(session);
    await working.clear(session);

    try {
      await ensureSessionWithPerms(session, { forceNewSession: true });
      await setSessionStatus(session, "idle");
      const extra =
        queued > 0
          ? ` · cleared ${queued} queued message${queued === 1 ? "" : "s"}`
          : "";
      const grantNote = revoked ? " · computer grant revoked" : "";
      await sendInTopic(
        session,
        `✨ **Fresh session** — agent history cleared; topic kept${extra}${grantNote}\n` +
          `Send a message to start a new conversation.`,
        undefined,
        { html: true },
      );
    } catch (err) {
      await setSessionStatus(session, "idle");
      await sendInTopic(
        session,
        `Failed to start fresh session:\n\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function applyComputerGrant(
    session: PersistedSession,
    opts: { watch: boolean },
  ): Promise<void> {
    await maybeRevokeComputerGrantIfHostChanged(session);
    let hostId: string;
    try {
      hostId = currentComputerHostId(session);
    } catch (err) {
      await sendInTopic(
        session,
        `🖥 Computer · ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const now = env.clock.now();
    const grant = {
      enabled: true,
      watch: opts.watch,
      expiresAt: now + COMPUTER_GRANT_TTL_MS,
      hostId,
    };
    if (!env.agents.computerGrant) {
      await sendInTopic(session, "🖥 Computer · host too old");
      return;
    }
    try {
      await env.agents.computerGrant({
        sessionKey: session.sessionKey,
        grant,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unknown type/i.test(msg)) {
        await sendInTopic(session, "🖥 Computer · host too old");
        return;
      }
      await sendInTopic(session, `🖥 Computer · grant failed: ${msg}`);
      return;
    }
    session.computerGrant = { ...grant, grantedAt: now };
    computerBound.add(session.sessionKey);
    session.updatedAt = now;
    sessionIndex.byKey[session.sessionKey] = session;
    await persistIndex();
    const token = newToken();
    computerPicks.set(token, { sessionKey: session.sessionKey });
    await sendInTopic(
      session,
      formatComputerGrantBanner({ grant: session.computerGrant, now }),
      computerKeyboard(token),
      { html: true },
    );
  }

  async function sendComputerStatus(session: PersistedSession): Promise<void> {
    const now = env.clock.now();
    const live = await syncComputerGrant(session);
    const token = newToken();
    computerPicks.set(token, { sessionKey: session.sessionKey });
    const line = formatComputerStatusLine({
      grant: live,
      now,
    });
    await sendInTopic(
      session,
      `${line}\n\`/computer off\`  ·  \`/cancel\` revokes grant`,
      computerKeyboard(token),
      { html: true },
    );
  }

  async function handleComputerCommand(
    session: PersistedSession,
    args: string[],
  ): Promise<void> {
    const sub = (args[0] ?? "").trim().toLowerCase();
    if (!sub || sub === "status") {
      await sendComputerStatus(session);
      return;
    }
    if (sub === "on") {
      await applyComputerGrant(session, { watch: false });
      return;
    }
    if (sub === "watch") {
      await applyComputerGrant(session, { watch: true });
      return;
    }
    if (sub === "off") {
      const revoked = await revokeComputerGrant(session);
      await sendInTopic(
        session,
        revoked ? "🖥 Computer grant revoked" : "🖥 Computer · off",
      );
      return;
    }
    await sendInTopic(
      session,
      "Usage: `/computer` · `/computer on` · `/computer off` · `/computer watch` · `/computer status`",
      undefined,
      { html: true },
    );
  }

  async function handleComputerCallback(
    data: string,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    const parsed = parseComputerCallback(data);
    if (!parsed) return;
    const pick = computerPicks.get(parsed.token);
    if (!pick) {
      await env.telegram
        .answerCallbackQuery({
          callbackQueryId,
          text: "Picker expired — /computer again",
        })
        .catch(() => {});
      return;
    }
    const session = sessionIndex.byKey[pick.sessionKey];
    if (!session) {
      computerPicks.delete(parsed.token);
      return;
    }
    const label =
      parsed.actionIndex === COMPUTER_CB.on
        ? "Enable"
        : parsed.actionIndex === COMPUTER_CB.watch
          ? "Watch"
          : parsed.actionIndex === COMPUTER_CB.off
            ? "Stop"
            : "OK";
    await env.telegram
      .answerCallbackQuery({ callbackQueryId, text: label })
      .catch(() => {});
    if (parsed.actionIndex === COMPUTER_CB.on) {
      await applyComputerGrant(session, { watch: false });
    } else if (parsed.actionIndex === COMPUTER_CB.watch) {
      await applyComputerGrant(session, { watch: true });
    } else if (parsed.actionIndex === COMPUTER_CB.off) {
      const revoked = await revokeComputerGrant(session);
      await sendInTopic(
        session,
        revoked ? "🖥 Computer grant revoked" : "🖥 Computer · off",
      );
    }
    if (message) {
      try {
        await env.telegram.editMessageText({
          chatId: message.chat.id,
          messageId: message.message_id,
          text: message.text ?? "🖥 Computer",
          replyMarkup: { inline_keyboard: [] },
        });
      } catch {
        /* */
      }
    }
  }

  /** Resolve session for worker-api / MCP tools or throw. */
  function requireSession(sessionKey: string): PersistedSession {
    const session = sessionIndex.byKey[sessionKey];
    if (!session) {
      throw new Error(
        `unknown session "${sessionKey}" — no topic mapped (is the worker hydrated?)`,
      );
    }
    return session;
  }

  /**
   * EVE control plane: orchestration runs on **acp-host** (survives worker restart).
   * Worker only proxies MCP/Telegram and delivers eve_notify to topics.
   */
  const eveHost = createAcpHostClient({
    sockPath: resolveAcpHostSockPath(stateDir),
    log,
    onEveNotify: ({ sessionKey, text, runId, ask }) => {
      const s = sessionIndex.byKey[sessionKey];
      if (!s) return;
      let keyboard: unknown;
      if (runId && ask && ask.length > 0) {
        try {
          keyboard = keyboardFromButtons(
            ask.map((o, i) => ({
              text: `${i + 1}. ${o.label}`.slice(0, 40),
              callback_data: encodeEveAskCallback(runId, i),
            })),
          );
        } catch (err) {
          log.warn("eve ask keyboard encode failed", {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      void sendInTopic(s, text, keyboard).catch((err) => {
        log.warn("eve_notify telegram failed", {
          sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
  });

  /** MCP → worker Unix API (token + topics stay on the daemon). */
  const workerHandlers = {
      async sendMessage({ sessionKey, text, kind }) {
        const session = requireSession(sessionKey);
        if (kind === "update") {
          // Edit the single “working…” bubble (create if missing).
          await working.set(session, text);
          log.info("worker-api update (working status)", {
            sessionKey,
            textLen: text.length,
            messageId: working.messageId(sessionKey),
          });
          return {
            message: `Updated working status (${text.length} chars).`,
          };
        }
        await sendInTopic(session, text);
        log.info("worker-api message", {
          sessionKey,
          kind,
          textLen: text.length,
        });
        return {
          message: `Sent Telegram message (${text.length} chars).`,
        };
      },
      async sendPhoto({ sessionKey, path, caption, filename }) {
        const session = requireSession(sessionKey);
        const data = new Uint8Array(await readFile(path));
        if (data.byteLength === 0) {
          throw new Error(`media file is empty: ${path}`);
        }
        if (!env.telegram.sendPhoto) {
          throw new Error("Telegram sendPhoto is not available on this host");
        }
        await env.telegram.sendPhoto({
          chatId: session.chatId,
          messageThreadId: session.messageThreadId,
          data,
          filename: filename ?? "photo.jpg",
          ...(caption?.trim() ? { caption: caption.trim() } : {}),
        });
        await working.bump(session).catch(() => {});
        log.info("worker-api photo", {
          sessionKey,
          path,
          bytes: data.byteLength,
        });
        return {
          message: `Sent Telegram photo (${data.byteLength} bytes).`,
          bytes: data.byteLength,
        };
      },
      async sendDocument({ sessionKey, path, caption, filename }) {
        const session = requireSession(sessionKey);
        const data = new Uint8Array(await readFile(path));
        if (data.byteLength === 0) {
          throw new Error(`media file is empty: ${path}`);
        }
        if (!env.telegram.sendDocument) {
          throw new Error(
            "Telegram sendDocument is not available on this host",
          );
        }
        await env.telegram.sendDocument({
          chatId: session.chatId,
          messageThreadId: session.messageThreadId,
          data,
          filename: filename ?? "file",
          ...(caption?.trim() ? { caption: caption.trim() } : {}),
        });
        await working.bump(session).catch(() => {});
        log.info("worker-api document", {
          sessionKey,
          path,
          bytes: data.byteLength,
        });
        return {
          message: `Sent Telegram file (${data.byteLength} bytes).`,
          bytes: data.byteLength,
        };
      },
      async speak({ sessionKey, text }) {
        const session = requireSession(sessionKey);
        const ttsMode = env.config.ttsMode ?? "agent";
        if (ttsMode === "off") {
          throw new Error("TTS is disabled (ttsMode=off)");
        }
        const ok = await turns.maybeSendTts(session, text, "worker-api-speak");
        if (!ok) {
          throw new Error("TTS unavailable or empty text");
        }
        await working.bump(session).catch(() => {});
        return {
          message: `Sent Telegram voice note (${text.length} chars).`,
        };
      },
      async reviewRun({
        sessionKey,
        mode,
        protocol,
        agent_a,
        agent_b,
        base,
        max_priority,
      }) {
        const session = requireSession(sessionKey);
        const maxPriority =
          max_priority === "P0" ||
          max_priority === "P1" ||
          max_priority === "P2" ||
          max_priority === "P3"
            ? max_priority
            : undefined;
        const result = await executeSessionReview(session, {
          mode: mode === "branch" ? "branch" : "local",
          protocol: protocol === "adversarial" ? "adversarial" : "panel",
          ...(agent_a ? { agentA: agent_a } : {}),
          ...(agent_b ? { agentB: agent_b } : {}),
          ...(base ? { base } : {}),
          ...(maxPriority ? { maxPriority } : {}),
          notifyProgress: true,
        });
        // Also post digest to the topic (MCP caller may not surface markdown).
        try {
          const body = result.markdown;
          const chunk = 3500;
          if (body.length <= chunk) {
            await sendInTopic(session, body);
          } else {
            for (let i = 0; i < body.length; i += chunk) {
              await sendInTopic(
                session,
                body.slice(i, i + chunk) +
                  (i + chunk < body.length ? "\n…" : ""),
              );
            }
          }
        } catch {
          /* best-effort */
        }
        return {
          message: `review ${result.protocol} complete (${result.reviewers.join(" + ")})`,
          markdown: result.markdown,
          resultPath: result.resultPath,
          bundleDir: result.bundle.dir,
          merged: result.merged,
        };
      },
      async agentSpawn({ sessionKey, name, agent, role, prompt, headless }) {
        const parent = requireSession(sessionKey);
        if (operatorChatId === undefined) {
          throw new Error("operator chat id unknown");
        }
        const repoKey = parent.identity.repo;
        const parentRepoRoot = parent.cwd;
        // Default headless — no dedicated Telegram topic
        const wantHeadless = headless !== false;
        // If parent is itself a child worktree, still use its cwd as git root
        const rec = await runAgentSpawn(
          {
            stateDir,
            parentRepoRoot,
            parentSessionKey: parent.sessionKey,
            repoKey,
            config: env.config.agentSpawn,
            createChildSession: async (input) => {
              const slash = input.sessionKey.indexOf("/");
              if (slash < 0) throw new Error(`bad sessionKey ${input.sessionKey}`);
              const repo = input.sessionKey.slice(0, slash);
              const namePart = input.sessionKey.slice(slash + 1);
              const identity = {
                repo,
                name: namePart,
                agent: input.agent,
              };
              const existing = sessionIndex.byKey[input.sessionKey];
              if (existing) {
                return {
                  sessionKey: existing.sessionKey,
                  messageThreadId: existing.messageThreadId,
                };
              }
              // Inherit parent ask/bypass
              const permissionMode = effectivePermissionMode(parent);
              await env.agents.ensureSession(identity, {
                permissionMode,
                cwd: input.cwd,
              });
              const now = env.clock.now();
              const isHeadless = input.headless !== false;
              let messageThreadId = parent.messageThreadId;
              if (!isHeadless) {
                const topic = await env.telegram.createForumTopic({
                  chatId: operatorChatId!,
                  name: initialTopicName(repo, namePart),
                });
                messageThreadId = topic.message_thread_id;
              }
              const record: PersistedSession = {
                sessionKey: input.sessionKey,
                identity: { ...identity },
                messageThreadId,
                chatId: operatorChatId!,
                status: "idle",
                cwd: input.cwd,
                permissionMode,
                parentSessionKey: input.parentSessionKey,
                spawnRunId: input.spawnRunId,
                ...(input.role ? { spawnRole: input.role } : {}),
                ...(isHeadless ? { headless: true } : {}),
                createdAt: now,
                updatedAt: now,
              };
              sessionIndex.byKey[input.sessionKey] = record;
              // Only topic children own a thread mapping
              if (!isHeadless) {
                sessionIndex.byThread[String(messageThreadId)] =
                  input.sessionKey;
              }
              await persistIndex();
              if (isHeadless) {
                await sendInTopic(
                  parent,
                  `Spawned **headless** child **${namePart}** (${input.agent})\n` +
                    `session: \`${input.sessionKey}\`\n` +
                    `worktree: \`${input.cwd}\`\n` +
                    `Permissions & asks surface **on this topic**.`,
                );
              } else {
                await sendInTopic(
                  parent,
                  `Spawned child **${namePart}** (${input.agent})\n` +
                    `session: \`${input.sessionKey}\`\n` +
                    `worktree: \`${input.cwd}\`\n` +
                    `topic thread: ${messageThreadId}`,
                );
              }
              return {
                sessionKey: input.sessionKey,
                messageThreadId,
              };
            },
            ensureAndMaybePrompt: async (input) => {
              const slash = input.sessionKey.indexOf("/");
              const repo = input.sessionKey.slice(0, slash);
              const namePart = input.sessionKey.slice(slash + 1);
              const identity = {
                repo,
                name: namePart,
                agent: input.agent,
              };
              await maybeRestoreClosedChild(input.sessionKey);
              const child = sessionIndex.byKey[input.sessionKey];
              const permissionMode = child
                ? effectivePermissionMode(child)
                : effectivePermissionMode(parent);
              const handle = await env.agents.ensureSession(identity, {
                permissionMode,
                cwd: input.cwd,
              });
              if (!input.prompt?.trim()) return {};
              if (child) {
                child.status = "running";
                await persistIndex();
              }
              let summary = "";
              try {
                const turn = await env.agents.runPromptTurn(handle, {
                  text: input.prompt.trim(),
                });
                for await (const ev of turn.events) {
                  if (ev.type === "agent_message_chunk" && ev.text) {
                    summary += ev.text;
                  }
                }
                await turn.done;
                const text = summary.trim() || "(no text)";
                await markChildResult(
                  stateDir,
                  input.sessionKey,
                  text,
                  "idle",
                );
                if (child && summary.trim()) {
                  await sendForSession(child, summary.trim().slice(0, 3500));
                }
                return { summary: text };
              } finally {
                if (child) {
                  child.status = "idle";
                  await persistIndex();
                }
              }
            },
          },
          {
            name,
            agent:
              agent?.trim() ||
              parent.identity.agent ||
              env.config.defaultAgent ||
              "grok-build",
            headless: wantHeadless,
            ...(role ? { role } : {}),
            ...(prompt ? { prompt } : {}),
          },
        );
        return {
          message: `Spawned ${rec.childSessionKey} on branch ${rec.branch}${rec.headless ? " (headless)" : ""}`,
          record: rec,
        };
      },
      async agentList({ sessionKey }) {
        requireSession(sessionKey);
        const children = await runAgentList(stateDir, sessionKey);
        return {
          message: `${children.length} child(ren)`,
          children,
        };
      },
      async agentKill({
        sessionKey,
        childSessionKey,
        id,
        dispose,
        removeWorktree,
      }) {
        const parent = requireSession(sessionKey);
        let target = childSessionKey?.trim() || id?.trim() || "";
        if (!target) throw new Error("childSessionKey required");
        const index = await loadSpawnIndex(stateDir);
        // allow slug
        if (!index.byChild[target] && !target.includes("/")) {
          target = `${sessionKey}--${target}`;
        }
        const hard = dispose !== false;
        const slug = target.includes("--")
          ? target.split("--").slice(-1)[0]!
          : target;
        const wtPath = index.byChild[target]?.worktreePath;
        const killed = await runAgentKill({
          stateDir,
          parentRepoRoot: parent.cwd,
          callerSessionKey: sessionKey,
          childSessionKey: target,
          dispose: hard,
          ...(removeWorktree !== undefined
            ? { removeWorktree }
            : {}),
          reason: hard ? "agent_kill" : "agent_kill soft-close",
          config: env.config.agentSpawn,
          killSession: async (key) => {
            await disposeHostSession(key);
          },
        });
        if (!killed) throw new Error(`unknown child ${target}`);
        if (hard) {
          const didRemove =
            removeWorktree === true ||
            (removeWorktree === undefined &&
              env.config.agentSpawn?.removeWorktreeOnKill === true);
          const wtNote = didRemove
            ? "worktree removed"
            : `worktree kept${wtPath ? ` at \`${wtPath}\`` : ""}`;
          await notifySpawnLifecycle(
            sessionKey,
            target,
            `Killed child **${slug}** (\`${target}\`) — ${wtNote}.`,
            "This sub-agent was killed and cleaned up.",
          );
          return {
            message: `Killed ${target} (${wtNote})`,
            worktreePath: didRemove ? undefined : wtPath,
          };
        }
        await notifySpawnLifecycle(
          sessionKey,
          target,
          `Closed child **${slug}** (\`${target}\`) — process stopped; session kept. agent_send or a new task restores it.`,
          "This sub-agent was closed (process stopped). Send a message to restore.",
        );
        return {
          message: `Closed ${target} (soft — restorable)`,
          record: killed,
        };
      },
      async agentSend({ sessionKey, to, message, mode }) {
        const parent = requireSession(sessionKey);
        const result = await runAgentSend(
          {
            stateDir,
            parentRepoRoot: parent.cwd,
            parentSessionKey: parent.sessionKey,
            repoKey: parent.identity.repo,
            callerSessionKey: sessionKey,
            createChildSession: async () => {
              throw new Error("unreachable");
            },
            ensureAndMaybePrompt: async () => {},
            deliverMessage: async (input) => {
              const sess = sessionIndex.byKey[input.sessionKey];
              if (!sess) throw new Error(`unknown session ${input.sessionKey}`);
              await maybeRestoreClosedChild(input.sessionKey);
              const handle = await env.agents.ensureSession(sess.identity, {
                permissionMode: sess.permissionMode ?? getDefaultPermissionMode(),
                cwd: sess.cwd,
              });
              sess.status = "running";
              await persistIndex();
              try {
                const turn = await env.agents.runPromptTurn(handle, {
                  text: input.message,
                  ...(input.mode === "steer" ? { mode: "steer" as const } : {}),
                });
                let summary = "";
                for await (const ev of turn.events) {
                  if (ev.type === "agent_message_chunk" && ev.text) {
                    summary += ev.text;
                  }
                }
                await turn.done;
                if (summary.trim()) {
                  await sendForSession(sess, summary.trim().slice(0, 3500));
                  await markChildResult(
                    stateDir,
                    input.sessionKey,
                    summary.trim(),
                    "idle",
                  );
                }
                return { summary: summary.trim() || undefined };
              } finally {
                sess.status = "idle";
                await persistIndex();
              }
            },
          },
          { to, message, mode },
        );
        return {
          message: `Sent to ${result.to}`,
          to: result.to,
          summary: result.summary,
        };
      },
      async agentWait({
        sessionKey,
        childSessionKey,
        id,
        to,
        timeout_sec,
        poll_sec,
      }) {
        requireSession(sessionKey);
        let target =
          childSessionKey?.trim() || id?.trim() || to?.trim() || "";
        if (!target) throw new Error("child target required");
        const index = await loadSpawnIndex(stateDir);
        try {
          target = resolveAgentTarget(index, sessionKey, target);
        } catch {
          if (!target.includes("/")) target = `${sessionKey}--${target}`;
        }
        const out = await runAgentWait({
          stateDir,
          callerSessionKey: sessionKey,
          childSessionKey: target,
          timeoutSec: timeout_sec,
          pollSec: poll_sec,
          isBusy: (key) => {
            const s = sessionIndex.byKey[key];
            return s?.status === "running" || s?.status === "waiting-on-you";
          },
        });
        return {
          message: `status=${out.status}`,
          status: out.status,
          summary: out.summary,
          sessionKey: out.sessionKey,
        };
      },
      // ── EVE (control plane → acp-host orchestration) ─────────────────
      async eveRun({
        sessionKey,
        name,
        path,
        source,
        args,
        skip_approval,
        agents_max,
      }) {
        const session = requireSession(sessionKey);
        const out = await eveHost.eveRun({
          sessionKey,
          repoKey: session.identity.repo,
          repoRoot: session.cwd,
          name,
          path,
          source,
          args,
          skipApproval: skip_approval === true,
          agentsMax: agents_max,
        });
        const run = out.run as
          | {
              name?: string;
              runId?: string;
              status?: string;
              phases?: { title: string }[];
            }
          | undefined;
        if (out.message && /pending approval/i.test(out.message)) {
          await sendInTopic(
            session,
            [
              `🛰 **EVE** · \`${run?.name ?? name ?? "directive"}\` ready`,
              run?.phases?.length
                ? run.phases.map((p) => p.title).join(" → ")
                : "",
              `\`/eve approve ${out.runId}\` · \`/eve kill ${out.runId}\``,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
        return {
          message: out.message ?? "ok",
          runId: out.runId,
          run: out.run,
        };
      },
      async eveApprove({ sessionKey, runId }) {
        requireSession(sessionKey);
        const out = await eveHost.eveApprove({ sessionKey, runId });
        return { message: out.message ?? `EVE approve/start: ${runId}` };
      },
      async eveStatus({ sessionKey, runId }) {
        requireSession(sessionKey);
        const out = await eveHost.eveStatus(runId);
        return {
          message: out.message ?? "status",
          run: out.run,
          text: out.text,
        };
      },
      async eveList({ sessionKey }) {
        const session = requireSession(sessionKey);
        const out = await eveHost.eveList({
          sessionKey,
          repoRoot: session.cwd,
        });
        return {
          message: out.message ?? "list",
          runs: out.runs,
          scripts: out.scripts,
        };
      },
      async evePause({ sessionKey, runId }) {
        requireSession(sessionKey);
        const out = await eveHost.evePause(runId);
        return { message: out.message ?? `paused ${runId}`, run: out.run };
      },
      async eveResume({ sessionKey, runId }) {
        requireSession(sessionKey);
        const out = await eveHost.eveResume({ sessionKey, runId });
        return { message: out.message ?? `resume ${runId}` };
      },
      async eveKill({ sessionKey, runId }) {
        requireSession(sessionKey);
        const out = await eveHost.eveKill(runId);
        return { message: out.message ?? `killed ${runId}`, run: out.run };
      },
      async eveAnswer({ sessionKey, runId, answer }) {
        requireSession(sessionKey);
        const out = await eveHost.eveAnswer({ sessionKey, runId, answer });
        return { message: out.message ?? `answered ${runId}`, run: out.run };
      },
      async eveWrite({ sessionKey, name, source, scope }) {
        const session = requireSession(sessionKey);
        const out = await eveHost.eveWrite({
          repoRoot: session.cwd,
          name,
          source,
          scope,
        });
        return {
          message: out.message ?? "wrote",
          path: out.path,
          meta: out.meta,
        };
      },
  };

  const workerApi = createWorkerApiServer({
    stateDir: stateDir,
    log,
    handlers: workerHandlers,
  });

  async function handleEveCommand(
    session: PersistedSession,
    args: string[],
  ): Promise<void> {
    const sub = (args[0] ?? "status").toLowerCase();
    try {
      if (sub === "help" || args.length === 0 || sub === "status") {
        if (sub === "status" && args[1]) {
          const out = await eveHost.eveStatus(args[1]!);
          await sendInTopic(
            session,
            out.text ?? out.message ?? JSON.stringify(out.run, null, 2),
          );
          return;
        }
        const out = await eveHost.eveList({
          sessionKey: session.sessionKey,
          repoRoot: session.cwd,
        });
        const scripts = (out.scripts ?? []) as {
          name: string;
        }[];
        const runs = (out.runs ?? []) as {
          runId: string;
          name: string;
          status: string;
          budget?: { agentsUsed?: number };
        }[];
        const lines = [
          `🛰 **EVE** — ${EVE_TAGLINE}`,
          "`/eve run <name>` · `/eve approve <id>` · `/eve status [id]`",
          "`/eve pause|resume|kill <id>` · `/eve answer <id> <n>`",
          "",
          scripts.length
            ? `Scripts: ${scripts
                .slice(0, 12)
                .map((s) => `\`${s.name}\``)
                .join(" · ")}`
            : "No scripts yet — agent writes `.acpbot/eve/`.",
          ...runs.slice(0, 6).map(
            (r) =>
              `· \`${r.runId.slice(0, 8)}\` **${r.name}** ${r.status}` +
              (r.budget?.agentsUsed != null
                ? ` · ${r.budget.agentsUsed} agents`
                : ""),
          ),
        ];
        await sendInTopic(session, lines.join("\n"));
        return;
      }

      if (sub === "list") {
        const out = await eveHost.eveList({
          sessionKey: session.sessionKey,
          repoRoot: session.cwd,
        });
        const scripts = (out.scripts ?? []) as {
          name: string;
          origin: string;
        }[];
        const runs = (out.runs ?? []) as {
          runId: string;
          name: string;
          status: string;
        }[];
        await sendInTopic(
          session,
          [
            "**Scripts**",
            ...scripts.map((s) => `· \`${s.name}\` (${s.origin})`),
            "",
            "**Runs** (host)",
            ...runs.map((r) => `· \`${r.runId}\` ${r.name} · ${r.status}`),
          ].join("\n") || "No EVE scripts or runs.",
        );
        return;
      }

      if (sub === "run") {
        const name = args[1];
        if (!name) {
          await sendInTopic(
            session,
            "Usage: `/eve run <name>` — name of a script under `.acpbot/eve/` (agent-authored)",
          );
          return;
        }
        const out = await workerHandlers.eveRun({
          sessionKey: session.sessionKey,
          name,
          skip_approval: false,
        });
        // Started with no approval gate: stay silent until done or help.
        return;
      }

      if (sub === "approve") {
        const runId = args[1];
        if (!runId) {
          await sendInTopic(session, "Usage: `/eve approve <runId>`");
          return;
        }
        await workerHandlers.eveApprove({
          sessionKey: session.sessionKey,
          runId,
        });
        // Stay silent — next ping is ask or complete.
        return;
      }

      if (sub === "answer") {
        const runs = ((
          await eveHost.eveList({
            sessionKey: session.sessionKey,
            repoRoot: session.cwd,
          })
        ).runs ?? []) as { runId: string; status: string }[];
        let runId = args[1];
        let choice = args.slice(2).join(" ").trim();
        if (runId && !choice && !/^[a-f0-9]{6,}$/i.test(runId)) {
          // `/eve answer 2` against the latest waiting run
          choice = runId;
          runId = undefined;
        }
        if (!runId) {
          const waiting = runs.find((r) => r.status === "waiting_user");
          runId = waiting?.runId;
        } else {
          const exact = runs.find((r) => r.runId === runId);
          const prefix = runs.filter((r) => r.runId.startsWith(runId!));
          runId = exact?.runId ?? (prefix.length === 1 ? prefix[0]!.runId : runId);
        }
        if (!runId || !choice) {
          await sendInTopic(
            session,
            "Usage: `/eve answer <runId> <n|id>` — or `/eve answer 1` for the parked run",
          );
          return;
        }
        await eveHost.eveAnswer({
          sessionKey: session.sessionKey,
          runId,
          answer: choice,
        });
        return;
      }

      if (sub === "pause" || sub === "resume" || sub === "kill") {
        const runId = args[1];
        if (!runId) {
          await sendInTopic(session, `Usage: \`/eve ${sub} <runId>\``);
          return;
        }
        if (sub === "pause") {
          await workerHandlers.evePause({
            sessionKey: session.sessionKey,
            runId,
          });
        } else if (sub === "resume") {
          await workerHandlers.eveResume({
            sessionKey: session.sessionKey,
            runId,
          });
        } else {
          await workerHandlers.eveKill({
            sessionKey: session.sessionKey,
            runId,
          });
        }
        await sendInTopic(session, `EVE ${sub} (host) · \`${runId}\``);
        return;
      }

      await sendInTopic(
        session,
        "EVE commands: run · approve · status · list · pause · resume · kill · answer",
      );
    } catch (err) {
      log.warn("eve command failed", {
        sessionKey: session.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
      await sendInTopic(
        session,
        `EVE failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
    const oauthStateDir = stateDir;
    const oauthConfigured = Boolean(
      process.env.ACPBOT_OAUTH_CALLBACK_BASE?.trim() ||
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
        // Attach empty mcp-proxy now (stdio children are fixed at spawn).
        // Auth later only fills tools — no second restart.
        let attachedNow = false;
        try {
          await ensureSessionWithPerms(session, { forceRespawn: true });
          attachedNow = true;
        } catch (err) {
          log.warn("mcp add proxy attach failed", {
            sessionKey: session.sessionKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        await sendInTopic(
          session,
          `Added MCP **${entry.name}** (${entry.type})\n${entry.url}\n\n` +
            `Written to \`.acpbot/mcp.json\` (id + url only; no tokens).\n` +
            (attachedNow
              ? `Per-topic **mcp-proxy** is attached (empty tools until auth).\n`
              : `Proxy will attach on the next message.\n`) +
            `Next: \`/mcp auth ${entry.name}\` if the gateway needs OAuth ` +
            `(tools appear without another agent restart).`,
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
            `Pending expires in 15 minutes. Tokens stay on the host (not in the repo).\n\n` +
            `After the browser succeeds the **mcp-proxy** (already attached) ` +
            `picks up the token and advertises tools — **no agent restart**.\n\n` +
            `If the browser cannot reach the host, paste the **full** final redirect URL:\n` +
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
        // Proxy should already be attached (empty tools). Only force-respawn
        // if this remote was never on the live slot (e.g. auth without prior ensure).
        await markMcpProxyAttachPending(oauthStateDir, result.repoKey, result.id);
        const need = await sessionNeedsFirstProxyAttach(session);
        let attachedNow = false;
        if (need.length > 0) {
          try {
            await ensureSessionWithPerms(session, { forceRespawn: true });
            attachedNow = true;
          } catch (err) {
            log.warn("mcp first-proxy attach failed", {
              sessionKey: session.sessionKey,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          await clearMcpProxyAttachPending(oauthStateDir, result.repoKey, [
            result.id,
          ]);
        }
        await sendInTopic(
          session,
          `OAuth complete for MCP **${result.id}**.\n` +
            `Token stored on host (not in repo).\n` +
            (attachedNow
              ? `Per-topic MCP proxy started for: ${need.join(", ")}.\nTools are ready.`
              : `Proxy already running — tools should appear shortly (no agent restart).`),
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
        `Mode → **\`${cur}\`**`,
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
      await ensureSessionWithPerms(session);
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
      }),
      keyboardFromButtons(buttons),
      { html: true },
    );
  }

  /**
   * /plan /build /mode — ACP session/set_mode control.
   */
  async function handleSessionModeCommand(
    session: PersistedSession,
    name: string,
    args: string[],
  ): Promise<void> {
    try {
      await ensureSessionWithPerms(session);
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

    // Ensure via acp-host (host spawns/loads if cold; reattaches if live), then
    // always re-query mode/model from the host — never a one-shot worker cache.
    let mode: string | undefined;
    let availableModes: string[] = [];
    let model: string | undefined;
    let effort: string | undefined;
    try {
      await ensureSessionWithPerms(session);
      if (env.agents.getSessionMode) {
        const st = await env.agents.getSessionMode(session.sessionKey);
        mode = st.currentModeId;
        availableModes = st.availableModeIds ?? [];
      }
      if (env.agents.getSessionConfigOptions) {
        const opts = await env.agents.getSessionConfigOptions(
          session.sessionKey,
        );
        model = currentModelLabel(opts as SessionConfigOptionView[]);
        // Status shows the effort id (high/medium/low), not agent display labels.
        const effortOpt = findEffortConfigOption(
          opts as SessionConfigOptionView[],
        );
        if (effortOpt?.currentValue != null) {
          effort = String(effortOpt.currentValue);
        }
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
            process.env.TACP_STATE_DIR?.trim() || "./data/acpbot-state",
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

    let linearLine: string | undefined;
    try {
      const binding = await loadLinearBinding(stateDir, session.sessionKey);
      linearLine = formatLinearBindingLine(binding);
    } catch {
      /* ignore */
    }

    const computerLine = formatComputerStatusLine({
      grant: await syncComputerGrant(session),
      now: env.clock.now(),
    });

    // Multi-agent: parent children + child→parent link
    let spawnParentKey: string | undefined;
    let spawnRole: string | undefined;
    let spawnStatus: string | undefined;
    let spawnBranch: string | undefined;
    let childLines:
      | Array<{
          slug: string;
          sessionKey: string;
          status: string;
          ageLabel: string;
          agent?: string;
          role?: string;
          closed?: boolean;
          headless?: boolean;
        }>
      | undefined;
    let childrenTruncated: number | undefined;
    try {
      const idx = await loadSpawnIndex(stateDir);
      const asChild = idx.byChild[session.sessionKey];
      if (asChild) {
        spawnParentKey = asChild.parentSessionKey;
        spawnRole = asChild.role;
        spawnStatus = asChild.status;
        spawnBranch = asChild.branch;
      }
      const kids = listChildren(idx, session.sessionKey);
      if (kids.length > 0) {
        const now = env.clock.now();
        const maxShow = 12;
        const shown = kids.slice(0, maxShow);
        childLines = shown.map((k) => {
          const slug = childSlugOf(k.childSessionKey);
          const isHeadless =
            k.headless === true ||
            sessionIndex.byKey[k.childSessionKey]?.headless === true;
          return {
            slug,
            sessionKey: k.childSessionKey,
            status: k.status,
            ageLabel: formatSpawnAge(now - k.updatedAt),
            agent: k.agent,
            ...(k.role ? { role: k.role } : {}),
            ...(isHeadless ? { headless: true } : {}),
            closed: k.status === "closed",
          };
        });
        if (kids.length > maxShow) {
          childrenTruncated = kids.length - maxShow;
        }
      }
    } catch {
      /* ignore spawn registry errors in status */
    }

    await sendInTopic(
      session,
      formatSessionStatus({
        sessionKey: session.sessionKey,
        status: session.status,
        agent,
        agentLabel: agentDisplayName(agent),
        launch,
        mode,
        model,
        effort,
        permissionMode: permissionModeLabel(effectivePermissionMode(session)),
        availableModes,
        cwd: session.cwd,
        threadId: session.messageThreadId,
        chatId: session.chatId,
        mcpEnabled,
        mcpCount,
        mcpNames,
        acpHost: true, // worker always uses acp-host
        ...(linearLine ? { linearLine } : {}),
        computerLine,
        ...(spawnParentKey ? { spawnParentKey } : {}),
        ...(spawnRole ? { spawnRole } : {}),
        ...(spawnStatus ? { spawnStatus } : {}),
        ...(spawnBranch ? { spawnBranch } : {}),
        ...(childLines ? { children: childLines } : {}),
        ...(childrenTruncated != null ? { childrenTruncated } : {}),
      }),
      undefined,
      { html: true },
    );
  }

  /** Best-effort: show Linear project name on the Telegram forum topic. */
  async function maybeRenameTopicForLinear(
    session: PersistedSession,
    binding: {
      projectId: string;
      projectName?: string;
    },
  ): Promise<void> {
    try {
      const base = topicName(session.identity.repo, session.identity.name);
      const name = formatLinearTopicTitle(base, {
        sessionKey: session.sessionKey,
        repoKey: session.identity.repo,
        projectId: binding.projectId,
        projectName: binding.projectName,
        boundAt: new Date().toISOString(),
        boundBy: "command",
      });
      await env.telegram.editForumTopic({
        chatId: session.chatId,
        messageThreadId: session.messageThreadId,
        name,
      });
    } catch (err) {
      log.warn("linear topic rename failed", {
        sessionKey: session.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * /linear — connect OAuth Linear MCP, bind topic↔project, work-through prompts.
   */
  async function handleLinearCommand(
    session: PersistedSession,
    args: string[],
  ): Promise<void> {
    const repoRoot = session.cwd;
    const repoKey = repoKeyForOAuth(session.identity.repo, repoRoot);
    const oauthStateDir = stateDir;
    const oauthConfigured = Boolean(
      process.env.ACPBOT_OAUTH_CALLBACK_BASE?.trim() ||
        process.env.TACP_OAUTH_CALLBACK_BASE?.trim(),
    );
    const sub = (args[0] ?? "status").toLowerCase();

    const startAgentPrompt = async (text: string): Promise<void> => {
      if (sessionTurnBusy(session.sessionKey)) {
        const { item, depth, dropped } = enqueueTopicPrompt(
          session.sessionKey,
          { text, attachments: [], kind: "prompt" },
        );
        const dropNote = dropped
          ? "\n_(oldest queued message dropped — queue full)_"
          : "";
        const sent = await sendInTopic(
          session,
          `📥 Queued Linear action (#${depth}). Will run after the current turn.${dropNote}`,
          keyboardFromButtons([
            {
              text: "Remove",
              callback_data: encodeQueueRemoveCallback(item.id),
            },
          ]),
          { html: true },
        );
        item.botMessageId = sent.message_id;
        return;
      }
      await beginTopicTurn(session, text, []);
    };

    try {
      if (args.length === 0 || sub === "status" || sub === "help") {
        if (sub === "help" || (args.length > 1 && sub === "status")) {
          await sendInTopic(session, LINEAR_COMMAND_USAGE);
          return;
        }
        const config = await readMcpConfig(repoRoot);
        const hasRemote = config.mcpServers.some(
          (s) =>
            typeof s.name === "string" &&
            s.name.trim() === LINEAR_MCP_ID &&
            typeof s.url === "string",
        );
        const tokenIds = oauthConfigured
          ? await listOAuthTokenIds(oauthStateDir, repoKey)
          : [];
        const authOk = tokenIds.includes(LINEAR_MCP_ID);
        const binding = await loadLinearBinding(
          oauthStateDir,
          session.sessionKey,
        );
        const lines = [
          "**Linear**",
          `MCP registry: ${hasRemote ? `**${LINEAR_MCP_ID}** registered` : "not registered — `/linear connect`"}`,
          oauthConfigured
            ? `OAuth: ${authOk ? "**connected**" : "missing — `/linear connect`"}`
            : "OAuth: callback not configured (set `[oauth].callback_base`)",
          formatLinearBindingLine(binding),
          "",
          `Official URL: \`${LINEAR_MCP.url}\``,
          "",
          "Commands: `connect` · `disconnect` · `project` · `unbind` · `export` · `next` · `work` · `fanout` · `help`",
        ];
        await sendInTopic(session, lines.join("\n"));
        return;
      }

      if (sub === "connect") {
        // Ensure official Linear remote is in mcp.json, attach proxy, start OAuth.
        const entry = await writeRemoteMcpServer(repoRoot, {
          name: LINEAR_MCP_ID,
          url: LINEAR_MCP.url,
        });
        log.info("linear connect registry", {
          sessionKey: session.sessionKey,
          name: entry.name,
          url: entry.url,
        });
        let attachedNow = false;
        try {
          await ensureSessionWithPerms(session, { forceRespawn: true });
          attachedNow = true;
        } catch (err) {
          log.warn("linear connect proxy attach failed", {
            sessionKey: session.sessionKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (!oauthConfigured) {
          await sendInTopic(
            session,
            `Added Linear MCP **${entry.name}**\n${entry.url}\n\n` +
              (attachedNow
                ? "Per-topic **mcp-proxy** attached.\n"
                : "Proxy will attach on the next message.\n") +
              "OAuth callback is **not** configured — set `[oauth].callback_base` " +
              "(see `acpbot setup`) then run `/linear connect` again, or `/mcp auth linear`.",
          );
          return;
        }

        const started = await startMcpOAuth({
          id: LINEAR_MCP_ID,
          resourceUrl: entry.url,
          repoRoot,
          repoKey,
          stateDir: oauthStateDir,
        });
        log.info("linear oauth auth started", {
          sessionKey: session.sessionKey,
          id: started.id,
          repoKey: started.repoKey,
        });
        await sendInTopic(
          session,
          `Linear MCP registered + authorize (open on your phone):\n\n` +
            `${started.authorizeUrl}\n\n` +
            `Redirect: \`${started.redirectUri}\`\n` +
            `Tokens stay on the host (not in the repo).\n` +
            (attachedNow
              ? "Proxy is attached (empty tools until auth completes).\n"
              : "Proxy attaches on next message after auth.\n") +
            `\nAfter auth: bind a project with \`/linear project <id|url>\` or \`/linear export\`.\n` +
            `Paste fallback: \`/mcp code <callback-url>\``,
        );
        return;
      }

      if (sub === "disconnect") {
        const alsoRemove = (args[1] ?? "").toLowerCase() === "remove";
        const deleted = await deleteOAuthToken(
          oauthStateDir,
          repoKey,
          LINEAR_MCP_ID,
        );
        let removedReg = false;
        if (alsoRemove) {
          removedReg = await removeMcpServer(repoRoot, LINEAR_MCP_ID);
        }
        await sendInTopic(
          session,
          [
            deleted
              ? "Linear OAuth token **removed** from host state."
              : "No Linear OAuth token was stored.",
            alsoRemove
              ? removedReg
                ? "Removed **linear** from `.acpbot/mcp.json`."
                : "No **linear** entry in `.acpbot/mcp.json`."
              : "Registry entry kept (run `/linear disconnect remove` to drop it).",
            "Topic project binding is unchanged — `/linear unbind` to clear.",
          ].join("\n"),
        );
        return;
      }

      if (sub === "unbind") {
        const removed = await deleteLinearBinding(
          oauthStateDir,
          session.sessionKey,
        );
        await sendInTopic(
          session,
          removed
            ? "Unbound Linear project from this topic."
            : "No Linear project was bound to this topic.",
        );
        return;
      }

      if (sub === "project") {
        const rest = args.slice(1).join(" ").trim();
        if (!rest) {
          const binding = await loadLinearBinding(
            oauthStateDir,
            session.sessionKey,
          );
          if (binding) {
            await sendInTopic(
              session,
              [
                formatLinearBindingLine(binding),
                "",
                "Rebind: `/linear project <id|url|name>`",
                "Clear: `/linear unbind`",
                "List/switch via agent: say “list Linear projects” or `/skills` → linear",
              ].join("\n"),
            );
            return;
          }
          await sendInTopic(
            session,
            "No project bound — asking the agent to list Linear projects…",
          );
          await startAgentPrompt(linearProjectPickPrompt());
          return;
        }
        const parsed = parseLinearProjectRef(rest);
        const record = await saveLinearBinding(oauthStateDir, {
          sessionKey: session.sessionKey,
          repoKey,
          projectId: parsed.projectId,
          ...(parsed.projectName ? { projectName: parsed.projectName } : {}),
          ...(parsed.projectUrl ? { projectUrl: parsed.projectUrl } : {}),
          boundBy: "command",
        });
        await maybeRenameTopicForLinear(session, record);
        await sendInTopic(
          session,
          `Bound this topic to Linear project **${record.projectName ?? record.projectId}**` +
            ` (\`${record.projectId}\`).\n` +
            (record.projectUrl ? `${record.projectUrl}\n` : "") +
            `Next: \`/linear next\` · \`/linear work <ISSUE>\` · \`/linear fanout\`.`,
        );
        return;
      }

      if (sub === "export") {
        const binding = await loadLinearBinding(
          oauthStateDir,
          session.sessionKey,
        );
        await sendInTopic(
          session,
          "Exporting plan → Linear project (agent turn)…",
        );
        await startAgentPrompt(linearExportPrompt(binding));
        return;
      }

      if (sub === "next") {
        const binding = await loadLinearBinding(
          oauthStateDir,
          session.sessionKey,
        );
        if (!binding) {
          await sendInTopic(
            session,
            "No Linear project bound. " +
              "Run `/linear project <id|url>` or `/linear export` first.",
          );
          return;
        }
        await sendInTopic(session, "Working next open issue (agent turn)…");
        await startAgentPrompt(linearNextPrompt(binding));
        return;
      }

      if (sub === "work") {
        const issueRef = args.slice(1).join(" ").trim();
        if (!issueRef) {
          await sendInTopic(session, "Usage: `/linear work <ISSUE>` (e.g. ENG-123)");
          return;
        }
        const binding = await loadLinearBinding(
          oauthStateDir,
          session.sessionKey,
        );
        // Remember last issue even if not fully bound
        if (binding) {
          await saveLinearBinding(oauthStateDir, {
            sessionKey: binding.sessionKey,
            repoKey: binding.repoKey,
            projectId: binding.projectId,
            projectName: binding.projectName,
            projectUrl: binding.projectUrl,
            teamId: binding.teamId,
            teamKey: binding.teamKey,
            lastIssueId: issueRef,
            boundBy: binding.boundBy,
          });
        }
        await sendInTopic(
          session,
          `Focusing Linear issue **${issueRef}** (agent turn)…`,
        );
        await startAgentPrompt(linearWorkPrompt(issueRef, binding));
        return;
      }

      if (sub === "fanout" || sub === "fan-out") {
        const binding = await loadLinearBinding(
          oauthStateDir,
          session.sessionKey,
        );
        if (!binding) {
          await sendInTopic(
            session,
            "No Linear project bound. " +
              "Run `/linear project <id|url>` or `/linear export` first.",
          );
          return;
        }
        await sendInTopic(
          session,
          "Multi-agent fan-out for bound project (agent turn)…",
        );
        await startAgentPrompt(linearFanoutPrompt(binding));
        return;
      }

      if (sub === "drain" || sub === "run") {
        const binding = await loadLinearBinding(
          oauthStateDir,
          session.sessionKey,
        );
        if (!binding) {
          await sendInTopic(
            session,
            "No Linear project bound. " +
              "Run `/linear project <id|url>` or `/linear export` first.",
          );
          return;
        }
        await sendInTopic(
          session,
          "🛰 **EVE** · agent will **author + run** a drain directive (no built-in script)…",
        );
        await startAgentPrompt(
          linearDrainPrompt(binding, {
            sequential: args.includes("--sequential"),
          }),
        );
        return;
      }

      await sendInTopic(session, LINEAR_COMMAND_USAGE);
    } catch (err) {
      log.warn("linear command failed", {
        sessionKey: session.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
      await sendInTopic(
        session,
        `Linear command failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function disposeHostSession(sessionKey: string): Promise<void> {
    try {
      if (env.agents.disposeSession) {
        await env.agents.disposeSession(sessionKey);
        return;
      }
    } catch {
      /* */
    }
    try {
      await env.agents.cancelTurn?.(sessionKey, "spawn close");
    } catch {
      /* */
    }
  }

  async function notifySpawnLifecycle(
    parentKey: string,
    childKey: string,
    textParent: string,
    textChild?: string,
  ): Promise<void> {
    const parent = sessionIndex.byKey[parentKey];
    if (parent) {
      try {
        await sendInTopic(parent, textParent);
      } catch {
        /* */
      }
    }
    const child = sessionIndex.byKey[childKey];
    // Headless children share the parent topic — skip duplicate child posts
    if (textChild && child && !child.headless) {
      try {
        await sendInTopic(child, textChild);
      } catch {
        /* */
      }
    }
  }

  async function maybeRestoreClosedChild(sessionKey: string): Promise<void> {
    try {
      const idx = await loadSpawnIndex(stateDir);
      const rec = idx.byChild[sessionKey];
      if (!rec || rec.status !== "closed") return;
      const restored = await agentMarkRestored(stateDir, sessionKey, () =>
        env.clock.now(),
      );
      if (!restored) return;
      const slug = sessionKey.includes("--")
        ? sessionKey.split("--").slice(-1)[0]!
        : sessionKey;
      await notifySpawnLifecycle(
        rec.parentSessionKey,
        sessionKey,
        `Restored child **${slug}** (\`${sessionKey}\`) — process starting again.`,
        "Sub-agent restored — process is starting again.",
      );
    } catch (err) {
      log.warn("spawn restore failed", {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleModelCommand(
    session: PersistedSession,
    args: string[],
  ): Promise<void> {
    try {
      await ensureSessionWithPerms(session);
    } catch (err) {
      await sendInTopic(
        session,
        `Could not attach agent: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!env.agents.getSessionConfigOptions || !env.agents.setSessionConfigOption) {
      await sendInTopic(
        session,
        "This agent backend does not support model config options.",
      );
      return;
    }

    let options: SessionConfigOptionView[];
    try {
      options = (await env.agents.getSessionConfigOptions(
        session.sessionKey,
      )) as SessionConfigOptionView[];
    } catch (err) {
      await sendInTopic(
        session,
        `Could not read model options: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const modelOpt = findModelConfigOption(options);
    if (!modelOpt || modelOpt.options.length === 0) {
      await sendInTopic(
        session,
        formatModelStatus({ configOptions: options }),
        undefined,
        { html: true },
      );
      return;
    }

    // /model <value>
    if (args[0]) {
      const token = args[0]!.trim();
      const hit =
        modelOpt.options.find(
          (o) =>
            o.value.toLowerCase() === token.toLowerCase() ||
            (o.name && o.name.toLowerCase() === token.toLowerCase()),
        ) ??
        modelOpt.options.find((o) =>
          o.value.toLowerCase().includes(token.toLowerCase()),
        );
      if (!hit) {
        await sendInTopic(
          session,
          `No model matching \`${token}\`.\n\n` +
            formatModelStatus({ configOptions: options }),
          undefined,
          { html: true },
        );
        return;
      }
      try {
        if (session.status === "running") {
          await env.agents.cancelTurn?.(
            session.sessionKey,
            "operator /model change",
          );
        }
        const next = await env.agents.setSessionConfigOption(
          session.sessionKey,
          modelOpt.id,
          hit.value,
        );
        const label =
          currentModelLabel(next as SessionConfigOptionView[]) ?? hit.value;
        await sendInTopic(
          session,
          `Model → **\`${label}\`**`,
          undefined,
          { html: true },
        );
      } catch (err) {
        await sendInTopic(
          session,
          `Failed to set model \`${hit.value}\`:\n\n${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    // Picker
    const token = newToken();
    modelPicks.set(token, {
      sessionKey: session.sessionKey,
      configId: modelOpt.id,
      values: modelOpt.options.map((o) => ({
        value: o.value,
        ...(o.name ? { name: o.name } : {}),
      })),
    });
    const buttons = modelOpt.options.map((o, i) => ({
      text:
        (o.value === modelOpt.currentValue ? "✓ " : "") +
        (o.name && o.name !== o.value ? o.name : o.value).slice(0, 28),
      callback_data: encodeModelCallback(token, i),
    }));
    buttons.push({
      text: "Cancel",
      callback_data: encodeModelCallback(token, -1),
    });
    await sendInTopic(
      session,
      formatModelStatus({ configOptions: options }),
      keyboardFromButtons(buttons),
      { html: true },
    );
  }

  async function handleEffortCommand(
    session: PersistedSession,
    args: string[],
  ): Promise<void> {
    try {
      await ensureSessionWithPerms(session);
    } catch (err) {
      await sendInTopic(
        session,
        `Could not attach agent: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!env.agents.getSessionConfigOptions || !env.agents.setSessionConfigOption) {
      await sendInTopic(
        session,
        "This agent backend does not support effort config options.",
      );
      return;
    }

    let options: SessionConfigOptionView[];
    try {
      options = (await env.agents.getSessionConfigOptions(
        session.sessionKey,
      )) as SessionConfigOptionView[];
    } catch (err) {
      await sendInTopic(
        session,
        `Could not read effort options: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const effortOpt = findEffortConfigOption(options);
    if (!effortOpt || effortOpt.options.length === 0) {
      await sendInTopic(
        session,
        formatEffortStatus({ configOptions: options }),
        undefined,
        { html: true },
      );
      return;
    }

    // /effort <value>
    if (args[0]) {
      const token = args[0]!.trim();
      const hit =
        effortOpt.options.find(
          (o) =>
            o.value.toLowerCase() === token.toLowerCase() ||
            (o.name && o.name.toLowerCase() === token.toLowerCase()),
        ) ??
        effortOpt.options.find((o) =>
          o.value.toLowerCase().includes(token.toLowerCase()),
        ) ??
        effortOpt.options.find(
          (o) => o.name && o.name.toLowerCase().includes(token.toLowerCase()),
        );
      if (!hit) {
        await sendInTopic(
          session,
          `No effort matching \`${token}\`.\n\n` +
            formatEffortStatus({ configOptions: options }),
          undefined,
          { html: true },
        );
        return;
      }
      try {
        if (session.status === "running") {
          await env.agents.cancelTurn?.(
            session.sessionKey,
            "operator /effort change",
          );
        }
        const next = await env.agents.setSessionConfigOption(
          session.sessionKey,
          effortOpt.id,
          hit.value,
        );
        await sendInTopic(
          session,
          `Effort → **\`${hit.value}\`**`,
          undefined,
          { html: true },
        );
      } catch (err) {
        await sendInTopic(
          session,
          `Failed to set effort \`${hit.value}\`:\n\n${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    // Picker — button labels are level ids (high / medium / low), not agent marketing names
    const token = newToken();
    effortPicks.set(token, {
      sessionKey: session.sessionKey,
      configId: effortOpt.id,
      values: effortOpt.options.map((o) => ({
        value: o.value,
        ...(o.name ? { name: o.name } : {}),
      })),
    });
    const buttons = effortOpt.options.map((o, i) => ({
      text:
        (o.value === effortOpt.currentValue ? "✓ " : "") +
        o.value.slice(0, 28),
      callback_data: encodeEffortCallback(token, i),
    }));
    buttons.push({
      text: "Cancel",
      callback_data: encodeEffortCallback(token, -1),
    });
    await sendInTopic(
      session,
      formatEffortStatus({ configOptions: options }),
      keyboardFromButtons(buttons),
      { html: true },
    );
  }

  type SessionReviewOpts = {
    mode?: "local" | "branch";
    protocol?: ReviewProtocol;
    agentA?: string;
    agentB?: string;
    base?: string;
    maxPriority?: ReviewPriority;
    notifyProgress?: boolean;
  };

  async function executeSessionReview(
    session: PersistedSession,
    opts: SessionReviewOpts = {},
  ) {
    const agents = listRegisteredAgents();
    if (agents.length < 2) {
      throw new Error(
        `Need two agent CLIs on PATH (have: ${agents.join(", ") || "none"})`,
      );
    }

    const mode = opts.mode ?? "local";
    const protocol = opts.protocol ?? "panel";
    const maxPriority: ReviewPriority = opts.maxPriority ?? "P0";

    const resolveAgent = (raw: string | undefined): string | undefined => {
      if (!raw) return undefined;
      const n = normalizeAgentName(raw);
      return (
        agents.find((a) => a === n) ??
        agents.find((a) => a.toLowerCase() === raw.toLowerCase()) ??
        agents.find(
          (a) => agentDisplayName(a).toLowerCase() === raw.toLowerCase(),
        )
      );
    };

    let agentA = resolveAgent(opts.agentA);
    let agentB = resolveAgent(opts.agentB);
    if (opts.agentA && !agentA) {
      throw new Error(
        `Unknown reviewer A "${opts.agentA}". Installed: ${agents.join(", ")}`,
      );
    }
    if (opts.agentB && !agentB) {
      throw new Error(
        `Unknown reviewer B "${opts.agentB}". Installed: ${agents.join(", ")}`,
      );
    }

    if (!agentA || !agentB) {
      const preferred = [
        "codex",
        "claude",
        "grok-build",
        "opencode",
        "cursor-agent",
      ];
      const ordered = [
        ...preferred.filter((p) => agents.includes(p)),
        ...agents.filter((a) => !preferred.includes(a)),
      ];
      agentA = agentA ?? ordered[0]!;
      agentB =
        agentB ?? ordered.find((a) => a !== agentA) ?? ordered[1]!;
    }
    if (agentA === agentB) {
      const other = agents.find((a) => a !== agentA);
      if (!other) throw new Error("Need two different agents for a panel");
      agentB = other;
    }

    return runReviewPanel({
      cwd: session.cwd,
      stateDir,
      mode,
      protocol,
      maxPriority,
      ...(opts.base ? { base: opts.base } : {}),
      reviewers: [
        { agent: agentA, label: agentA },
        { agent: agentB, label: agentB },
      ],
      onProgress: async (msg) => {
        if (opts.notifyProgress === false) return;
        await sendInTopic(session, `🔍 ${msg}`).catch(() => {});
      },
      runReviewer: async ({ agent, label, prompt, cwd, reviewId }) => {
        const slug = `rvw-${reviewId.slice(0, 8)}-${label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "")
          .slice(0, 10)}`;
        const identity = {
          repo: session.identity.repo,
          name: slug,
          agent,
        };
        const handle = await env.agents.ensureSession(identity, {
          cwd,
          permissionMode: "ask",
          forceNewSession: true,
        });
        let text = "";
        try {
          try {
            const modes = await env.agents.getSessionMode?.(handle.sessionKey);
            const ids = modes?.availableModeIds ?? [];
            const prefer =
              ids.find((m) => /^(plan|ask|read-only|readonly)$/i.test(m)) ??
              ids.find((m) => /plan|ask|read/i.test(m));
            if (prefer && env.agents.setSessionMode) {
              await env.agents.setSessionMode(handle.sessionKey, prefer);
            }
          } catch {
            /* mode optional */
          }
          const turn = await env.agents.runPromptTurn(handle, {
            text: prompt,
          });
          for await (const ev of turn.events) {
            if (ev.type === "agent_message_chunk" && ev.text) {
              text += ev.text;
            }
          }
          await turn.done;
        } finally {
          try {
            await env.agents.disposeSession?.(handle.sessionKey);
          } catch {
            try {
              await env.agents.cancelTurn?.(
                handle.sessionKey,
                "review complete",
              );
            } catch {
              /* */
            }
          }
        }
        return { text };
      },
    });
  }

  /**
   * /review [local|branch] [agentA] [agentB] [panel|adversarial]
   * Two-agent closeout review against a frozen git bundle.
   */
  async function handleReviewCommand(
    session: PersistedSession,
    args: string[],
  ): Promise<void> {
    const usage =
      "Usage: `/review [local|branch] [agentA] [agentB] [panel|adversarial]`\n\n" +
      "Examples:\n" +
      "• `/review` — local dirty, first two installed agents, panel\n" +
      "• `/review branch codex claude`\n" +
      "• `/review local codex claude adversarial`\n\n" +
      "Advisory only — verify findings before applying fixes.";

    let mode: "local" | "branch" = "local";
    let protocol: ReviewProtocol = "panel";
    const tokens = [...args];
    if (tokens[0] === "local" || tokens[0] === "branch") {
      mode = tokens.shift() as "local" | "branch";
    }
    if (
      tokens.length > 0 &&
      (tokens[tokens.length - 1] === "panel" ||
        tokens[tokens.length - 1] === "adversarial")
    ) {
      protocol = tokens.pop() as ReviewProtocol;
    }

    const agentA = tokens[0];
    const agentB = tokens[1];

    await sendInTopic(
      session,
      `🔍 **Review** starting…\n` +
        `target: **${mode}** · protocol: **${protocol}**\n` +
        `A: \`${agentA ?? "(auto)"}\` · B: \`${agentB ?? "(auto)"}\``,
      undefined,
      { html: true },
    );

    try {
      const result = await executeSessionReview(session, {
        mode,
        protocol,
        ...(agentA ? { agentA } : {}),
        ...(agentB ? { agentB } : {}),
        notifyProgress: true,
      });

      const body = result.markdown;
      const chunk = 3500;
      if (body.length <= chunk) {
        await sendInTopic(session, body);
      } else {
        for (let i = 0; i < body.length; i += chunk) {
          await sendInTopic(
            session,
            body.slice(i, i + chunk) +
              (i + chunk < body.length ? "\n…" : ""),
          );
        }
      }
      await sendInTopic(
        session,
        `Artifacts: \`${result.bundle.dir}\`\n` +
          `(\`${result.resultPath}\`)`,
        undefined,
        { html: true },
      );
    } catch (err) {
      await sendInTopic(
        session,
        `Review failed:\n\n${err instanceof Error ? err.message : String(err)}\n\n${usage}`,
      );
    }
  }

  async function handleAgentCommand(
    session: PersistedSession,
    args: string[],
  ): Promise<void> {
    const agents = listRegisteredAgents();
    if (agents.length === 0) {
      await sendInTopic(
        session,
        "No agent CLIs found on PATH.\n\n" +
          "Install `grok`, `claude`, `codex`, `opencode`, and/or `cursor-agent`, then retry `/agent`.\n" +
          "Or set `TACP_AGENTS_ALL=1` to list the full registry regardless of PATH.",
      );
      return;
    }

    const apply = async (agentId: string) => {
      if (!env.agents.switchSessionAgent) {
        // Fallback: update identity + ensureSession with agent change
        session.identity = { ...session.identity, agent: agentId };
        sessionIndex.byKey[session.sessionKey] = session;
        await saveSessionIndex(env.store, sessionIndex);
        if (session.status === "running") {
          await env.agents.cancelTurn?.(
            session.sessionKey,
            "operator /agent switch",
          );
        }
        await ensureSessionWithPerms(session);
      } else {
        if (session.status === "running") {
          await env.agents.cancelTurn?.(
            session.sessionKey,
            "operator /agent switch",
          );
        }
        const handle = await env.agents.switchSessionAgent(
          session.identity,
          agentId,
        );
        session.identity = handle.identity;
        sessionIndex.byKey[session.sessionKey] = session;
        await saveSessionIndex(env.store, sessionIndex);
      }
      const launch = resolveAgentLaunch(agentId);
      await sendInTopic(
        session,
        `Agent → **\`${agentDisplayName(agentId)}\`** · restarted`,
        undefined,
        { html: true },
      );
    };

    if (args[0]) {
      const raw = args[0]!.trim();
      const id =
        agents.find((a) => a.toLowerCase() === raw.toLowerCase()) ??
        agents.find(
          (a) => agentDisplayName(a).toLowerCase() === raw.toLowerCase(),
        ) ??
        agents.find((a) => a.toLowerCase().includes(raw.toLowerCase())) ??
        agents.find((a) =>
          agentDisplayName(a).toLowerCase().includes(raw.toLowerCase()),
        );
      if (!id) {
        await sendInTopic(
          session,
          `Unknown agent \`${raw}\`.\n\nInstalled: ${
            agents.map((a) => `\`${agentDisplayName(a)}\``).join(", ") ||
            "_(none on PATH)_"
          }`,
          undefined,
          { html: true },
        );
        return;
      }
      try {
        await apply(id);
      } catch (err) {
        await sendInTopic(
          session,
          `Failed to switch agent:\n\n${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    const cur =
      session.identity.agent ?? env.config.defaultAgent ?? "grok-build";
    const token = newToken();
    agentPicks.set(token, { sessionKey: session.sessionKey, agents });
    const buttons = agents.map((id, i) => ({
      text:
        (id === cur || agentDisplayName(id) === cur ? "✓ " : "") +
        agentDisplayName(id).slice(0, 28),
      callback_data: encodeAgentCallback(token, i),
    }));
    buttons.push({
      text: "Cancel",
      callback_data: encodeAgentCallback(token, -1),
    });
    await sendInTopic(
      session,
      `**Agent:** \`${agentDisplayName(cur)}\` · restart on switch`,
      keyboardFromButtons(buttons),
      { html: true },
    );
  }

  async function handleModelCallback(
    data: string,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    const parsed = parseModelCallback(data);
    if (!parsed) return;
    const pick = modelPicks.get(parsed.token);
    if (!pick) {
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Picker expired — /model again",
        });
      } catch {
        /* */
      }
      return;
    }
    const session = sessionIndex.byKey[pick.sessionKey];
    if (!session) {
      modelPicks.delete(parsed.token);
      return;
    }
    if (parsed.valueIndex === -1) {
      modelPicks.delete(parsed.token);
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Cancelled",
        });
      } catch {
        /* */
      }
      if (message) {
        try {
          await env.telegram.editMessageText({
            chatId: message.chat.id,
            messageId: message.message_id,
            text: "Model picker cancelled.",
            replyMarkup: { inline_keyboard: [] },
          });
        } catch {
          /* */
        }
      }
      return;
    }
    const choice = pick.values[parsed.valueIndex];
    modelPicks.delete(parsed.token);
    if (!choice || !env.agents.setSessionConfigOption) return;
    try {
      await env.telegram.answerCallbackQuery({
        callbackQueryId,
        text: `→ ${choice.value}`,
      });
    } catch {
      /* */
    }
    try {
      if (session.status === "running") {
        await env.agents.cancelTurn?.(
          session.sessionKey,
          "operator /model change",
        );
      }
      const next = await env.agents.setSessionConfigOption(
        session.sessionKey,
        pick.configId,
        choice.value,
      );
      const label =
        currentModelLabel(next as SessionConfigOptionView[]) ?? choice.value;
      await sendInTopic(
        session,
        `Model → **\`${label}\`**`,
        undefined,
        { html: true },
      );
    } catch (err) {
      await sendInTopic(
        session,
        `Failed to set model:\n\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleEffortCallback(
    data: string,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    const parsed = parseEffortCallback(data);
    if (!parsed) return;
    const pick = effortPicks.get(parsed.token);
    if (!pick) {
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Picker expired — /effort again",
        });
      } catch {
        /* */
      }
      return;
    }
    const session = sessionIndex.byKey[pick.sessionKey];
    if (!session) {
      effortPicks.delete(parsed.token);
      return;
    }
    if (parsed.valueIndex === -1) {
      effortPicks.delete(parsed.token);
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Cancelled",
        });
      } catch {
        /* */
      }
      if (message) {
        try {
          await env.telegram.editMessageText({
            chatId: message.chat.id,
            messageId: message.message_id,
            text: "Effort picker cancelled.",
            replyMarkup: { inline_keyboard: [] },
          });
        } catch {
          /* */
        }
      }
      return;
    }
    const choice = pick.values[parsed.valueIndex];
    effortPicks.delete(parsed.token);
    if (!choice || !env.agents.setSessionConfigOption) return;
    try {
      await env.telegram.answerCallbackQuery({
        callbackQueryId,
        text: `→ ${choice.value}`,
      });
    } catch {
      /* */
    }
    try {
      if (session.status === "running") {
        await env.agents.cancelTurn?.(
          session.sessionKey,
          "operator /effort change",
        );
      }
      const next = await env.agents.setSessionConfigOption(
        session.sessionKey,
        pick.configId,
        choice.value,
      );
      await sendInTopic(
        session,
        `Effort → **\`${choice.value}\`**`,
        undefined,
        { html: true },
      );
    } catch (err) {
      await sendInTopic(
        session,
        `Failed to set effort:\n\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleAgentCallback(
    data: string,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    const parsed = parseAgentCallback(data);
    if (!parsed) return;
    const pick = agentPicks.get(parsed.token);
    if (!pick) {
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Picker expired — /agent again",
        });
      } catch {
        /* */
      }
      return;
    }
    const session = sessionIndex.byKey[pick.sessionKey];
    if (!session) {
      agentPicks.delete(parsed.token);
      return;
    }
    if (parsed.agentIndex === -1) {
      agentPicks.delete(parsed.token);
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Cancelled",
        });
      } catch {
        /* */
      }
      if (message) {
        try {
          await env.telegram.editMessageText({
            chatId: message.chat.id,
            messageId: message.message_id,
            text: "Agent picker cancelled.",
            replyMarkup: { inline_keyboard: [] },
          });
        } catch {
          /* */
        }
      }
      return;
    }
    const agentId = pick.agents[parsed.agentIndex];
    agentPicks.delete(parsed.token);
    if (!agentId) return;
    try {
      await env.telegram.answerCallbackQuery({
        callbackQueryId,
        text: `→ ${agentId}`,
      });
    } catch {
      /* */
    }
    try {
      if (session.status === "running") {
        await env.agents.cancelTurn?.(
          session.sessionKey,
          "operator /agent switch",
        );
      }
      if (env.agents.switchSessionAgent) {
        const handle = await env.agents.switchSessionAgent(
          session.identity,
          agentId,
        );
        session.identity = handle.identity;
      } else {
        session.identity = { ...session.identity, agent: agentId };
        await ensureSessionWithPerms(session);
      }
      sessionIndex.byKey[session.sessionKey] = session;
      await saveSessionIndex(env.store, sessionIndex);
      const launch = resolveAgentLaunch(agentId);
      await sendInTopic(
        session,
        `Agent → **\`${agentId}\`** · restarted`,
        undefined,
        { html: true },
      );
    } catch (err) {
      await sendInTopic(
        session,
        `Failed to switch agent:\n\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

  /**
   * Apply topic-level ask|bypass: persist session, re-ensure agent slot.
   */
  async function applyTopicPermissionMode(
    session: PersistedSession,
    mode: PermissionMode,
  ): Promise<{ prev: PermissionMode }> {
    const prev = effectivePermissionMode(session);
    session.permissionMode = mode;
    session.updatedAt = env.clock.now();
    sessionIndex.byKey[session.sessionKey] = session;
    await persistIndex();

    // Respawn agent so Grok --always-approve / yoloMode and ACP modes apply.
    if (prev !== mode) {
      try {
        if (session.status === "running") {
          await env.agents.cancelTurn?.(
            session.sessionKey,
            "operator /permissions change",
          );
        }
        // forceRespawn: session-host also keys on permissionMode, but force
        // guarantees a clean spawn with the new policy flags.
        await ensureSessionWithPerms(session, { forceRespawn: true });
      } catch (err) {
        log.warn("permissions: re-ensure after change failed", {
          sessionKey: session.sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("session permission mode set", {
      sessionKey: session.sessionKey,
      mode,
      prev,
    });
    return { prev };
  }

  function topicPermissionAppliedText(mode: PermissionMode): string {
    return `Permissions → **\`${permissionModeLabel(mode)}\`** (this topic)`;
  }

  function defaultPermissionAppliedText(
    mode: PermissionMode,
    _session?: PersistedSession,
  ): string {
    return (
      `Default permissions → **\`${permissionModeLabel(mode)}\`**` +
      (configPath ? " · config saved" : "")
    );
  }

  /**
   * /permissions — tool auto-approve policy (not session plan/build mode).
   * Topic: this session · `default <mode>`: new topics · bare: status + Ask/Bypass buttons.
   * Lobby: status + buttons set the default (and config.toml).
   */
  async function handlePermissionsCommand(
    args: string[],
    opts: {
      session?: PersistedSession;
      reply: (
        text: string,
        replyMarkup?: unknown,
        extra?: { html?: boolean },
      ) => Promise<unknown>;
      scope: "lobby" | "topic";
      /** Lobby chat id for default-picker callbacks. */
      chatId?: number;
    },
  ): Promise<void> {
    const { session, reply, scope } = opts;
    const a0 = args[0]?.toLowerCase();
    const a1 = args[1]?.toLowerCase();

    // /permissions default [ask|bypass]
    if (a0 === "default") {
      if (!a1) {
        // Picker for default
        const token = newToken();
        permissionModePicks.set(token, {
          scope: "default",
          ...(session ? { sessionKey: session.sessionKey } : {}),
          ...(opts.chatId !== undefined ? { chatId: opts.chatId } : {}),
        });
        const current = getDefaultPermissionMode();
        await reply(
          formatPermissionStatus({
            defaultMode: current,
            session: session?.permissionMode,
          }) + "\n_Default for new topics:_",
          permissionModeKeyboard(token, current),
          { html: true },
        );
        return;
      }
      const mode = parsePermissionMode(a1);
      if (!mode) {
        await reply(
          `Unknown \`${a1}\` — use \`ask\` or \`bypass\`.`,
          undefined,
          { html: true },
        );
        return;
      }
      await saveRuntimePermissionDefault(mode);
      log.info("permission default updated", { mode, via: "slash" });
      await reply(defaultPermissionAppliedText(mode, session), undefined, {
        html: true,
      });
      return;
    }

    // Bare /permissions — status + two buttons
    if (!a0) {
      const token = newToken();
      if (scope === "topic" && session) {
        permissionModePicks.set(token, {
          scope: "topic",
          sessionKey: session.sessionKey,
        });
        const current = effectivePermissionMode(session);
        await reply(
          formatPermissionStatus({
            defaultMode: getDefaultPermissionMode(),
            session: session.permissionMode,
          }),
          permissionModeKeyboard(token, current),
          { html: true },
        );
        return;
      }
      // Lobby: buttons set default
      permissionModePicks.set(token, {
        scope: "default",
        ...(opts.chatId !== undefined ? { chatId: opts.chatId } : {}),
      });
      const current = getDefaultPermissionMode();
      await reply(
        formatPermissionStatus({
          defaultMode: current,
        }) + "\n_Default for new topics:_",
        permissionModeKeyboard(token, current),
        { html: true },
      );
      return;
    }

    // Topic-only: /permissions ask|bypass
    if (scope === "lobby") {
      await reply(
        "Lobby sets the **default** — use buttons, or `/permissions default ask|bypass`.\n" +
          "Per-topic: run `/permissions` inside a session topic.",
        undefined,
        { html: true },
      );
      return;
    }

    if (!session) {
      await reply("No session.", undefined, { html: true });
      return;
    }

    const mode = parsePermissionMode(a0);
    if (!mode) {
      const token = newToken();
      permissionModePicks.set(token, {
        scope: "topic",
        sessionKey: session.sessionKey,
      });
      await reply(
        `Unknown \`${a0}\`.\n` +
          formatPermissionStatus({
            defaultMode: getDefaultPermissionMode(),
            session: session.permissionMode,
          }),
        permissionModeKeyboard(token, effectivePermissionMode(session)),
        { html: true },
      );
      return;
    }

    await applyTopicPermissionMode(session, mode);
    await reply(topicPermissionAppliedText(mode), undefined, { html: true });
  }

  async function handlePermissionModeCallback(
    data: string,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    const parsed = parsePermissionModeCallback(data);
    if (!parsed) return;

    const pick = permissionModePicks.get(parsed.token);
    if (!pick) {
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Picker expired — run /permissions again",
        });
      } catch {
        /* ignore */
      }
      return;
    }

    // Cancel not used (two-button only), but accept -1 if present
    if (parsed.modeIndex < 0) {
      permissionModePicks.delete(parsed.token);
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
            text: "Permission picker cancelled.",
            replyMarkup: { inline_keyboard: [] },
          });
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const opt = PERMISSION_MODE_OPTIONS[parsed.modeIndex];
    if (!opt) {
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: "Invalid choice",
        });
      } catch {
        /* ignore */
      }
      return;
    }

    permissionModePicks.delete(parsed.token);
    const mode = opt.mode;

    try {
      await env.telegram.answerCallbackQuery({
        callbackQueryId,
        text: `→ ${permissionModeLabel(mode)}`,
      });
    } catch {
      /* ignore */
    }

    let resultText: string;
    if (pick.scope === "topic") {
      const session = pick.sessionKey
        ? sessionIndex.byKey[pick.sessionKey]
        : undefined;
      if (!session) {
        resultText = "Session gone — open the topic and run /permissions again.";
      } else {
        await applyTopicPermissionMode(session, mode);
        resultText = topicPermissionAppliedText(mode);
      }
    } else {
      await saveRuntimePermissionDefault(mode);
      log.info("permission default updated", { mode, via: "button" });
      const session = pick.sessionKey
        ? sessionIndex.byKey[pick.sessionKey]
        : undefined;
      resultText = defaultPermissionAppliedText(mode, session);
    }

    const formatted = formatForTelegram(resultText);
    if (message) {
      try {
        await env.telegram.editMessageText({
          chatId: message.chat.id,
          messageId: message.message_id,
          text: formatted.text,
          replyMarkup: { inline_keyboard: [] },
          ...(formatted.parseMode
            ? { parseMode: formatted.parseMode }
            : {}),
        });
        return;
      } catch {
        /* fall through to send new message */
      }
    }

    // Fallback: send a new message
    if (pick.scope === "topic" && pick.sessionKey) {
      const session = sessionIndex.byKey[pick.sessionKey];
      if (session) {
        await sendInTopic(session, resultText, undefined, { html: true });
        return;
      }
    }
    const chatId =
      pick.chatId ?? message?.chat.id ?? operatorChatId ?? undefined;
    if (chatId !== undefined) {
      await replyInRoot(chatId, resultText, undefined, { html: true });
    }
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
      if (slash.name === "/fresh") {
        await handleFreshCommand(session);
        return;
      }
      if (slash.name === "/steer") {
        await handleSteerCommand(session, slash.args);
        return;
      }
      if (slash.name === "/queue") {
        await handleQueueCommand(session);
        return;
      }
      if (slash.name === "/unqueue") {
        await handleUnqueueCommand(session, slash.args);
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
      if (slash.name === "/computer") {
        await handleComputerCommand(session, slash.args);
        return;
      }
      if (slash.name === "/model") {
        await handleModelCommand(session, slash.args);
        return;
      }
      if (slash.name === "/effort") {
        await handleEffortCommand(session, slash.args);
        return;
      }
      if (slash.name === "/permissions") {
        await handlePermissionsCommand(slash.args, {
          session,
          scope: "topic",
          reply: (text, replyMarkup, extra) =>
            sendInTopic(session, text, replyMarkup, extra),
        });
        return;
      }
      if (slash.name === "/agent") {
        await handleAgentCommand(session, slash.args);
        return;
      }
      if (slash.name === "/review") {
        await handleReviewCommand(session, slash.args);
        return;
      }
      if (slash.name === "/mcp") {
        await handleMcpCommand(session, slash.args);
        return;
      }
      if (slash.name === "/linear") {
        await handleLinearCommand(session, slash.args);
        return;
      }
      if (slash.name === "/eve") {
        await handleEveCommand(session, slash.args);
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

    // Serialize turns: if a prompt is already in flight, queue this one (non-interrupt).
    if (sessionTurnBusy(session.sessionKey)) {
      const { item, depth, dropped } = enqueueTopicPrompt(session.sessionKey, {
        text: agentText,
        attachments,
        kind: "prompt",
      });
      log.info("action: queue prompt (turn busy)", {
        sessionKey: session.sessionKey,
        depth,
        dropped,
        textLen: agentText.length,
        attachments: attachments.length,
        id: item.id,
      });
      const dropNote = dropped
        ? "\n_(oldest queued message dropped — queue full)_"
        : "";
      const sent = await sendInTopic(
        session,
        `📥 Queued (#${depth}). Will run after the current turn.${dropNote}\n_Remove: button · \`/unqueue\`_`,
        keyboardFromButtons([
          {
            text: "Remove",
            callback_data: encodeQueueRemoveCallback(item.id),
          },
        ]),
        { html: true },
      );
      // Stash ack message id for later edit-on-remove
      item.botMessageId = sent.message_id;
      return;
    }

    await beginTopicTurn(session, agentText, attachments, pendingSkill?.skill.id);
  }

  /**
   * Start an agent turn for a topic session. When it finishes, drains the
   * per-session prompt queue (FIFO).
   */
  async function beginTopicTurn(
    session: PersistedSession,
    agentText: string,
    attachments: PromptAttachment[],
    skillId?: string,
  ): Promise<void> {
    // Sticky Linear context on free-text turns when topic is bound.
    let textForAgent = agentText;
    try {
      const binding = await loadLinearBinding(stateDir, session.sessionKey);
      textForAgent = applyLinearTurnContext(agentText, binding);
    } catch {
      /* ignore */
    }

    log.info("action: start turn", {
      sessionKey: session.sessionKey,
      mode: session.status === "running" ? "steer" : "prompt",
      textLen: textForAgent.length,
      stickyLinear: textForAgent !== agentText,
      attachments: attachments.length,
      skillId,
    });
    // One “⏳ Working…” bubble in this topic; MCP update edits it; final clears it.
    await working.ensure(session, "Starting agent…");
    try {
      const handle = await ensureSessionWithPerms(session);
      await working.set(session, "Working…").catch(() => {});
      const ac = new AbortController();
      turnAbort.set(session.sessionKey, ac);

      const turn = await env.agents.runPromptTurn(handle, {
        text: textForAgent,
        ...(attachments.length > 0 ? { attachments } : {}),
        mode: session.status === "running" ? "steer" : "prompt",
        signal: ac.signal,
      });

      const drain = turns
        .drainTurn(session, turn.events)
        .catch(async () => {
          try {
            await setSessionStatus(session, "failed");
          } catch {
            /* ignore */
          }
        })
        .finally(() => {
          drainTasks.delete(session.sessionKey);
          turnAbort.delete(session.sessionKey);
          // Kick the next queued operator message (if any), unless /steer is
          // about to start immediately after interrupt.
          maybePumpAfterTurn(session.sessionKey);
        });
      drainTasks.set(session.sessionKey, drain);
      void turn.done.catch(() => {});
    } catch (err) {
      await working.clear(session);
      drainTasks.delete(session.sessionKey);
      turnAbort.delete(session.sessionKey);
      const msg = err instanceof Error ? err.message : String(err);
      log.error("start turn failed", {
        sessionKey: session.sessionKey,
        error: msg,
      });
      try {
        await setSessionStatus(session, "failed");
        await sendInTopic(
          session,
          `**Could not start turn**\n\n\`${msg}\`\n\n` +
            `Try again, or \`/fresh\` if the agent is stuck after a restart.`,
          undefined,
          { html: true },
        );
      } catch {
        /* ignore notify failure */
      }
      // Still try to run queued work after a failed start.
      maybePumpAfterTurn(session.sessionKey);
      // Don't rethrow — handleUpdate already finished; rethrow only left a log line
      // and a vanishing ⏳ with no operator-visible error.
    }
  }

  async function pumpPromptQueue(sessionKey: string): Promise<void> {
    if (skipQueuePump.has(sessionKey)) return;
    if (sessionTurnBusy(sessionKey)) return;
    const q = promptQueues.get(sessionKey);
    if (!q || q.length === 0) {
      promptQueues.delete(sessionKey);
      return;
    }
    const session = sessionIndex.byKey[sessionKey];
    if (!session) {
      promptQueues.delete(sessionKey);
      return;
    }
    const next = q.shift()!;
    if (q.length === 0) promptQueues.delete(sessionKey);
    queueItemSessions.delete(next.id);
    const remaining = q.length;
    log.info("action: dequeue prompt", {
      sessionKey,
      remaining,
      textLen: next.text.length,
      attachments: next.attachments.length,
    });
    // Drop the "📥 Queued…" ack so the chat does not keep stale queue UI.
    await deleteQueueAck(session, next);
    if (remaining > 0) {
      await sendInTopic(
        session,
        `▶️ Running next queued message (${remaining} still waiting)…`,
        undefined,
        { html: true },
      ).catch(() => {});
    }
    try {
      await beginTopicTurn(session, next.text, next.attachments);
    } catch (err) {
      log.warn("queued turn failed", {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
      await sendInTopic(
        session,
        `Queued turn failed: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {});
      // Continue with remaining queue
      void pumpPromptQueue(sessionKey);
    }
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
      `**Skill:** \`${skill.id}\` — send your prompt now.`,
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

  async function handleEveAskCallback(
    runId: string,
    optionIndex: number,
    callbackQueryId: string,
    message?: TelegramMessage,
  ): Promise<void> {
    try {
      const threadId = message?.message_thread_id;
      const sessionKey =
        (threadId != null
          ? sessionIndex.byThread[String(threadId)]
          : undefined) ??
        Object.keys(sessionIndex.byKey)[0] ??
        "";
      const out = await eveHost.eveAnswer({
        sessionKey,
        runId,
        answer: String(optionIndex + 1),
      });
      await env.telegram.answerCallbackQuery({
        callbackQueryId,
        text: out.message ?? "Recorded",
      });
      if (message && out.message) {
        try {
          await env.telegram.editMessageText({
            chatId: message.chat.id,
            messageId: message.message_id,
            text: `${message.text ?? "EVE question"}\n\n→ ${out.message}`,
            replyMarkup: { inline_keyboard: [] },
          });
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      try {
        await env.telegram.answerCallbackQuery({
          callbackQueryId,
          text: err instanceof Error ? err.message.slice(0, 180) : "failed",
        });
      } catch {
        /* ignore */
      }
    }
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

    const modelCb = parseModelCallback(cq.data);
    if (modelCb) {
      await handleModelCallback(cq.data, cq.id, cq.message);
      return;
    }

    const effortCb = parseEffortCallback(cq.data);
    if (effortCb) {
      await handleEffortCallback(cq.data, cq.id, cq.message);
      return;
    }

    const agentCb = parseAgentCallback(cq.data);
    if (agentCb) {
      await handleAgentCallback(cq.data, cq.id, cq.message);
      return;
    }

    const permModeCb = parsePermissionModeCallback(cq.data);
    if (permModeCb) {
      await handlePermissionModeCallback(cq.data, cq.id, cq.message);
      return;
    }

    const queueToken = parseQueueRemoveCallback(cq.data);
    if (queueToken) {
      await handleQueueRemoveCallback(cq.data, cq.id, cq.message);
      return;
    }

    const computerCb = parseComputerCallback(cq.data);
    if (computerCb) {
      await handleComputerCallback(cq.data, cq.id, cq.message);
      return;
    }

    const eveAsk = parseEveAskCallback(cq.data);
    if (eveAsk) {
      await handleEveAskCallback(eveAsk.runId, eveAsk.optionIndex, cq.id, cq.message);
      return;
    }

    const repoIdx = parseNewRepoCallback(cq.data);
    if (repoIdx !== undefined && chatId !== undefined) {
      await handleNewRepoCallback(repoIdx, chatId, cq.id, cq.message);
    }
  }

  /**
   * Operator reacted to a bot message — inject a synthetic prompt so the agent
   * (e.g. SXM) can learn. All emoji / custom_emoji tokens are forwarded as-is.
   *
   * Telegram often omits message_thread_id on message_reaction — routing relies
   * on the outbound message index (persisted across worker restarts). Cold
   * agent slots are ensured via beginTopicTurn → ensureSessionWithPerms.
   */
  async function handleMessageReaction(
    reaction: MessageReactionUpdated,
  ): Promise<void> {
    if (!reactionSetChanged(reaction)) {
      log.debug("ignore reaction no-op", {
        message_id: reaction.message_id,
        chat: reaction.chat.id,
      });
      return;
    }

    const outbound = outboundMessages.lookup(
      reaction.chat.id,
      reaction.message_id,
    );
    const threadId =
      reaction.message_thread_id ?? outbound?.messageThreadId;

    let sessionKey: string | undefined;
    if (threadId !== undefined) {
      sessionKey = sessionIndex.byThread[String(threadId)];
    }
    if (!sessionKey) {
      sessionKey = outbound?.sessionKey;
    }
    // Last resort: single session in this chat (rare: one topic only).
    if (!sessionKey) {
      const inChat = Object.values(sessionIndex.byKey).filter(
        (s) => s.chatId === reaction.chat.id,
      );
      if (inChat.length === 1) {
        sessionKey = inChat[0]!.sessionKey;
        log.info("reaction session inferred (sole topic in chat)", {
          sessionKey,
          message_id: reaction.message_id,
        });
      }
    }
    if (!sessionKey) {
      log.warn("ignore reaction: unknown session", {
        message_id: reaction.message_id,
        chat: reaction.chat.id,
        thread: threadId,
        hasOutbound: Boolean(outbound),
        indexSize: outboundMessages.size(),
        hint:
          "message_id not in outbound index (pre-index message or lost file). React to a newer bot reply.",
      });
      return;
    }
    const session = sessionIndex.byKey[sessionKey];
    if (!session) {
      log.warn("ignore reaction: session key missing from index", {
        sessionKey,
        message_id: reaction.message_id,
      });
      return;
    }

    const agentText = formatTelegramReactionPrompt(reaction, {
      ...(outbound?.textPreview !== undefined
        ? { textPreview: outbound.textPreview }
        : {}),
      ...(outbound?.textTruncated ? { textTruncated: true } : {}),
      ...(outbound?.kind ? { kind: outbound.kind } : {}),
    });
    log.info("action: message reaction", {
      sessionKey,
      message_id: reaction.message_id,
      added: reaction.new_reaction?.length,
      hasPreview: Boolean(outbound?.textPreview),
      textLen: agentText.length,
      sessionStatus: session.status,
    });

    // Closed/soft-closed children: restore before queuing/turning.
    try {
      await maybeRestoreClosedChild(session.sessionKey);
    } catch (err) {
      log.warn("reaction: restore closed child failed", {
        sessionKey: session.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (sessionTurnBusy(session.sessionKey)) {
      const { item, depth, dropped } = enqueueTopicPrompt(session.sessionKey, {
        text: agentText,
        attachments: [],
        kind: "prompt",
      });
      log.info("action: queue reaction (turn busy)", {
        sessionKey: session.sessionKey,
        depth,
        dropped,
        id: item.id,
      });
      return;
    }

    try {
      await beginTopicTurn(session, agentText, []);
    } catch (err) {
      log.error("reaction: failed to start agent turn", {
        sessionKey: session.sessionKey,
        message_id: reaction.message_id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Surface so operator knows the reaction was not swallowed.
      try {
        await sendInTopic(
          session,
          `⚠️ Could not start agent for your reaction: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } catch {
        /* ignore */
      }
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

    const senderId = senderOf(update);
    // CLI pair approve may have completed while we were idle.
    await applyCliPairingIfAny();

    if (env.config.operatorUserId <= 0) {
      const chatId =
        update.message?.chat.id ??
        update.edited_message?.chat.id ??
        update.callback_query?.message?.chat.id ??
        update.message_reaction?.chat.id;
      const chatType =
        update.message?.chat.type ??
        update.edited_message?.chat.type ??
        update.callback_query?.message?.chat.type ??
        update.message_reaction?.chat.type;
      // Only private chats can pair (no group claim races).
      if (
        senderId !== undefined &&
        chatId !== undefined &&
        (chatType === undefined || chatType === "private")
      ) {
        const from =
          update.message?.from ??
          update.edited_message?.from ??
          update.callback_query?.from ??
          update.message_reaction?.user;
        await issuePairingForUser(senderId, chatId, from);
      }
      return;
    }
    if (!isOperator(senderId)) {
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

    if (update.message_reaction) {
      await handleMessageReaction(update.message_reaction);
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

    try {
      await workerApi.listen();
      log.info("startup: worker API listening", {
        sockPath: workerApi.sockPath,
      });
      console.error(`acpbot worker API: unix://${workerApi.sockPath}`);
    } catch (err) {
      log.error("startup: worker API failed to listen", {
        sockPath: workerApi.sockPath,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // Soft-close idle spawned children (default 24h). Keeps Telegram session.
    const idleHours = env.config.agentSpawn?.idleCloseHours;
    const idleCloseMs =
      idleHours != null && idleHours > 0
        ? idleHours * 60 * 60 * 1000
        : idleHours === 0
          ? 0
          : 24 * 60 * 60 * 1000;
    let idleSweepTimer: ReturnType<typeof setInterval> | undefined;
    if (idleCloseMs > 0) {
      const sweepMs = Math.min(
        15 * 60 * 1000,
        Math.max(60_000, Math.floor(idleCloseMs / 48)),
      );
      const sweepIdleChildren = async () => {
        try {
          const due = await listIdleCloseableChildren(
            stateDir,
            idleCloseMs,
            env.clock.now(),
          );
          for (const rec of due) {
            if (sessionTurnBusy(rec.childSessionKey)) continue;
            const slug = rec.childSessionKey.includes("--")
              ? rec.childSessionKey.split("--").slice(-1)[0]!
              : rec.childSessionKey;
            const closed = await runAgentClose({
              stateDir,
              callerSessionKey: rec.parentSessionKey,
              childSessionKey: rec.childSessionKey,
              reason: `auto-idle-${idleHours ?? 24}h`,
              now: () => env.clock.now(),
              killSession: async (key) => {
                await disposeHostSession(key);
              },
            });
            if (!closed) continue;
            log.info("spawn auto soft-close", {
              child: rec.childSessionKey,
              parent: rec.parentSessionKey,
              idleHours: idleHours ?? 24,
            });
            await notifySpawnLifecycle(
              rec.parentSessionKey,
              rec.childSessionKey,
              `Closed child **${slug}** (idle ≥ ${idleHours ?? 24}h) — process stopped; session kept. agent_send restores it.`,
              `This sub-agent was auto-closed after ${idleHours ?? 24}h idle. Send a message to restore.`,
            );
          }
        } catch (err) {
          log.warn("spawn idle sweep failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };
      idleSweepTimer = setInterval(() => {
        void sweepIdleChildren();
      }, sweepMs);
      // First pass after boot (delayed)
      setTimeout(() => void sweepIdleChildren(), 30_000);
      log.info("spawn idle soft-close enabled", {
        idleCloseHours: idleHours ?? 24,
        sweepMs,
      });
    }

    const onAbort = () => {
      if (idleSweepTimer) clearInterval(idleSweepTimer);
      void workerApi.close();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    started = true;
    log.info("startup: poll loop begin", {
      operatorUserId: env.config.operatorUserId,
      operatorChatId,
      sessions: Object.keys(sessionIndex.byKey).length,
      workerApiSock: workerApi.sockPath,
    });

    let offset = await loadUpdateOffset(env.store);

    try {
      while (!signal?.aborted) {
      await applyCliPairingIfAny();

      let updates: TelegramUpdate[];
      try {
        updates = await env.telegram.getUpdates({
          offset,
          timeout: pollTimeoutSec,
          // Explicit list required to receive message_reaction (not in default).
          allowedUpdates: [
            "message",
            "edited_message",
            "callback_query",
            "message_reaction",
          ],
        });
      } catch (err) {
        if (signal?.aborted) break;
        if (err instanceof TelegramApiError && err.statusCode === 409) {
          log.warn("getUpdates 409 conflict; backing off", {
            backoffMs: conflictBackoffMs,
          });
          try {
            await env.clock.sleep(conflictBackoffMs, signal);
          } catch {
            break;
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
          break;
        }
        continue;
      }

      if (updates.length === 0) {
        try {
          await env.clock.sleep(conflictBackoffMs, signal);
        } catch {
          break;
        }
        continue;
      }

      for (const update of updates) {
        if (signal?.aborted) break;
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
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await workerApi.close();
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
