import {
  TelegramApiError,
  type AnswerCallbackQueryParams,
  type BotMe,
  type CreateForumTopicParams,
  type DeleteMessageParams,
  type DeleteMyCommandsParams,
  type EditForumTopicParams,
  type EditMessageTextParams,
  type ForumTopic,
  type GetMyCommandsParams,
  type GetUpdatesParams,
  type SendChatActionParams,
  type SendMessageParams,
  type SetMyCommandsParams,
  type TelegramBotCommand,
  type TelegramPort,
  type TelegramUpdate,
} from "./types";

export type OutboundTelegramCall =
  | { method: "getMe" }
  | { method: "getUpdates"; params: GetUpdatesParams }
  | { method: "sendMessage"; params: SendMessageParams }
  | { method: "sendChatAction"; params: SendChatActionParams }
  | { method: "editMessageText"; params: EditMessageTextParams }
  | { method: "deleteMessage"; params: DeleteMessageParams }
  | { method: "editForumTopic"; params: EditForumTopicParams }
  | { method: "createForumTopic"; params: CreateForumTopicParams }
  | { method: "answerCallbackQuery"; params: AnswerCallbackQueryParams }
  | { method: "setMyCommands"; params: SetMyCommandsParams }
  | { method: "deleteMyCommands"; params: DeleteMyCommandsParams }
  | { method: "getMyCommands"; params: GetMyCommandsParams }
  | { method: "getFile"; params: { fileId: string } }
  | { method: "downloadFile"; params: { fileId: string } }
  | {
      method: "sendVoice";
      params: import("./types").SendVoiceParams;
    }
  | {
      method: "sendDocument";
      params: import("./types").SendDocumentParams;
    }
  | {
      method: "sendPhoto";
      params: import("./types").SendPhotoParams;
    };

export type FakeTelegramOptions = {
  me?: BotMe;
  /** When true, getUpdates throws 409 Conflict. */
  conflictOnGetUpdates?: boolean;
};

/**
 * Telegram double: records outbound calls and accepts injected updates.
 * getUpdates hands out queued updates once, respecting offset as ack.
 */
export function fakeTelegram(options: FakeTelegramOptions = {}): TelegramPort & {
  outbound: OutboundTelegramCall[];
  inject(update: TelegramUpdate): void;
  injectMany(updates: TelegramUpdate[]): void;
  setConflict(on: boolean): void;
  setMe(me: BotMe): void;
  /** Wait until at least n outbound calls of a method exist. */
  waitFor(
    method: OutboundTelegramCall["method"],
    count?: number,
    timeoutMs?: number,
  ): Promise<OutboundTelegramCall[]>;
  clearOutbound(): void;
  /** Outbound sendMessage calls only (common assertion surface). */
  sentMessages(): Array<SendMessageParams & { message_id: number }>;
} {
  const me: BotMe = options.me ?? {
    id: 1,
    is_bot: true,
    first_name: "acpbot",
    username: "tacp_bot",
    has_topics_enabled: true,
  };

  let conflict = options.conflictOnGetUpdates ?? false;
  const pending: TelegramUpdate[] = [];
  const outbound: OutboundTelegramCall[] = [];
  let nextMessageId = 1;
  let nextThreadId = 100;
  const topics = new Map<number, { name: string; chatId: number }>();
  /** scopeKey → commands (for getMyCommands) */
  const menus = new Map<string, TelegramBotCommand[]>();
  const menuKey = (scope?: Record<string, unknown>, lang?: string) =>
    `${scope ? JSON.stringify(scope) : "default"}|${lang ?? ""}`;
  /** file_id → bytes for downloadFile tests */
  const files = new Map<string, Uint8Array>();
  const waiters: Array<{
    method: OutboundTelegramCall["method"];
    count: number;
    resolve: (calls: OutboundTelegramCall[]) => void;
  }> = [];

  const notify = () => {
    for (const w of [...waiters]) {
      const matches = outbound.filter((c) => c.method === w.method);
      if (matches.length >= w.count) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(matches);
      }
    }
  };

  const record = (call: OutboundTelegramCall) => {
    outbound.push(call);
    notify();
  };

  const api: TelegramPort & {
    outbound: OutboundTelegramCall[];
    inject(update: TelegramUpdate): void;
    injectMany(updates: TelegramUpdate[]): void;
    setConflict(on: boolean): void;
    setMe(me: BotMe): void;
    waitFor(
      method: OutboundTelegramCall["method"],
      count?: number,
      timeoutMs?: number,
    ): Promise<OutboundTelegramCall[]>;
    clearOutbound(): void;
    sentMessages(): Array<SendMessageParams & { message_id: number }>;
  } = {
    outbound,

    setMe(next: BotMe) {
      Object.assign(me, next);
    },

    setConflict(on: boolean) {
      conflict = on;
    },

    inject(update: TelegramUpdate) {
      pending.push(update);
    },

    injectMany(updates: TelegramUpdate[]) {
      pending.push(...updates);
    },

    clearOutbound() {
      outbound.length = 0;
    },

    sentMessages() {
      return outbound
        .filter(
          (c): c is { method: "sendMessage"; params: SendMessageParams } =>
            c.method === "sendMessage",
        )
        .map((c, i) => ({ ...c.params, message_id: i + 1 }));
    },

    waitFor(method, count = 1, timeoutMs = 2000) {
      const existing = outbound.filter((c) => c.method === method);
      if (existing.length >= count) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolveWrapped);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(
            new Error(
              `timeout waiting for ${count} ${method} call(s); saw ${outbound.filter((c) => c.method === method).length}`,
            ),
          );
        }, timeoutMs);
        const resolveWrapped = (calls: OutboundTelegramCall[]) => {
          clearTimeout(timer);
          resolve(calls);
        };
        waiters.push({ method, count, resolve: resolveWrapped });
      });
    },

    async getMe() {
      record({ method: "getMe" });
      return { ...me };
    },

    async getUpdates(params: GetUpdatesParams) {
      record({ method: "getUpdates", params });
      if (conflict) {
        throw new TelegramApiError(
          409,
          "Conflict: terminated by other getUpdates request",
        );
      }
      const offset = params.offset ?? 0;
      // Deliver updates with update_id >= offset (offset is last+1).
      const deliverable = pending.filter((u) => u.update_id >= offset);
      // Remove delivered from pending (acked by next offset from caller).
      for (const u of deliverable) {
        const idx = pending.indexOf(u);
        if (idx >= 0) pending.splice(idx, 1);
      }
      return deliverable.map((u) => structuredClone(u));
    },

    async sendMessage(params: SendMessageParams) {
      record({ method: "sendMessage", params: { ...params } });
      const message_id = nextMessageId++;
      return { message_id };
    },

    async sendChatAction(params: SendChatActionParams) {
      record({ method: "sendChatAction", params: { ...params } });
    },

    async editMessageText(params: EditMessageTextParams) {
      record({ method: "editMessageText", params: { ...params } });
    },

    async deleteMessage(params: DeleteMessageParams) {
      record({ method: "deleteMessage", params: { ...params } });
    },

    async editForumTopic(params: EditForumTopicParams) {
      record({ method: "editForumTopic", params: { ...params } });
      const t = topics.get(params.messageThreadId);
      if (t && params.name !== undefined) t.name = params.name;
    },

    async createForumTopic(params: CreateForumTopicParams): Promise<ForumTopic> {
      record({ method: "createForumTopic", params: { ...params } });
      const message_thread_id = nextThreadId++;
      topics.set(message_thread_id, {
        name: params.name,
        chatId: params.chatId,
      });
      return {
        message_thread_id,
        name: params.name,
        icon_color: params.iconColor,
      };
    },

    async answerCallbackQuery(params: AnswerCallbackQueryParams) {
      record({ method: "answerCallbackQuery", params: { ...params } });
    },

    async setMyCommands(params: SetMyCommandsParams) {
      record({ method: "setMyCommands", params: { ...params } });
      menus.set(
        menuKey(params.scope, params.languageCode),
        params.commands.map((c) => ({ ...c })),
      );
    },

    async deleteMyCommands(params: DeleteMyCommandsParams = {}) {
      record({ method: "deleteMyCommands", params: { ...params } });
      menus.delete(menuKey(params.scope, params.languageCode));
    },

    async getMyCommands(params: GetMyCommandsParams = {}) {
      record({ method: "getMyCommands", params: { ...params } });
      return (
        menus.get(menuKey(params.scope, params.languageCode)) ?? []
      ).map((c) => ({ ...c }));
    },

    async getFile(fileId: string) {
      record({ method: "getFile", params: { fileId } });
      return {
        file_id: fileId,
        file_path: `fake/${fileId}`,
        file_size: files.get(fileId)?.byteLength,
      };
    },

    async downloadFile(fileId: string) {
      record({ method: "downloadFile", params: { fileId } });
      const data = files.get(fileId);
      if (!data) {
        // Default tiny payload for tests that inject photo/voice without seed
        return new TextEncoder().encode(`fake-bytes:${fileId}`);
      }
      return data;
    },

    async sendVoice(params) {
      record({ method: "sendVoice", params: { ...params } });
      return { message_id: nextMessageId++ };
    },

    async sendDocument(params) {
      record({ method: "sendDocument", params: { ...params } });
      return { message_id: nextMessageId++ };
    },

    async sendPhoto(params) {
      record({ method: "sendPhoto", params: { ...params } });
      return { message_id: nextMessageId++ };
    },
  };

  /** Test helper: seed downloadable file bytes */
  (api as typeof api & { seedFile: (id: string, data: Uint8Array) => void }).seedFile =
    (id, data) => {
      files.set(id, data);
    };

  return api as typeof api & {
    seedFile: (id: string, data: Uint8Array) => void;
  };
}
