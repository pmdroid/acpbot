import type { SessionIdentity, SessionStatus, Store } from "../env/types";

export const STORE_KEYS = {
  updateOffset: "telegram:updateOffset",
  operatorChatId: "telegram:operatorChatId",
  sessions: "sessions:index",
} as const;

export type PersistedSession = {
  sessionKey: string;
  identity: SessionIdentity;
  messageThreadId: number;
  chatId: number;
  status: SessionStatus;
  cwd: string;
  /**
   * Per-topic tool-permission policy override.
   * When unset, worker uses config / runtime default.
   */
  permissionMode?: "ask" | "bypass";
  createdAt: number;
  updatedAt: number;
  /** Set when session was created via agent_spawn (parent host slot). */
  parentSessionKey?: string | null;
  spawnRunId?: string;
  spawnRole?: string;
  /**
   * Headless multi-agent child: no dedicated Telegram topic.
   * Operator UI (permissions, summaries) surfaces on the parent topic.
   * messageThreadId mirrors the parent for send helpers; byThread must not
   * map the parent thread to this session.
   */
  headless?: boolean;
};

export type SessionIndex = {
  /** sessionKey → record */
  byKey: Record<string, PersistedSession>;
  /** message_thread_id → sessionKey */
  byThread: Record<string, string>;
};

export function emptySessionIndex(): SessionIndex {
  return { byKey: {}, byThread: {} };
}

export async function loadSessionIndex(store: Store): Promise<SessionIndex> {
  const idx = await store.load<SessionIndex>(STORE_KEYS.sessions);
  return idx ?? emptySessionIndex();
}

export async function saveSessionIndex(
  store: Store,
  index: SessionIndex,
): Promise<void> {
  await store.save(STORE_KEYS.sessions, index);
}

export async function loadUpdateOffset(store: Store): Promise<number> {
  return (await store.load<number>(STORE_KEYS.updateOffset)) ?? 0;
}

export async function saveUpdateOffset(
  store: Store,
  offset: number,
): Promise<void> {
  await store.save(STORE_KEYS.updateOffset, offset);
}

export async function loadOperatorChatId(
  store: Store,
): Promise<number | undefined> {
  return store.load<number>(STORE_KEYS.operatorChatId);
}

export async function saveOperatorChatId(
  store: Store,
  chatId: number,
): Promise<void> {
  await store.save(STORE_KEYS.operatorChatId, chatId);
}
