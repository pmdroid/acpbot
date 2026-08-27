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
  type Logger,
  type SendChatActionParams,
  type SendDocumentParams,
  type SendMessageParams,
  type SendPhotoParams,
  type SendVoiceParams,
  type SetMyCommandsParams,
  type TelegramBotCommand,
  type TelegramFileInfo,
  type TelegramPort,
  type TelegramUpdate,
} from "./types";
import { silentLogger, summarizeUpdate } from "./logger";

export type RealTelegramOptions = {
  /** Bot token from configuration — never hardcoded, never assumed on disk. */
  token: string;
  /** Optional override for API base (tests / proxies). */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  log?: Logger;
};

/**
 * Long-polling Telegram Bot API client. Token is injected; no ambient env read.
 */
export function realTelegram(options: RealTelegramOptions): TelegramPort {
  const base =
    options.apiBase ?? `https://api.telegram.org/bot${options.token}`;
  const filesRoot = `https://api.telegram.org/file/bot${options.token}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = (options.log ?? silentLogger()).child("telegram");

  async function call<T>(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const started = Date.now();
    // Never log the full tokenized URL or request body secrets.
    if (method !== "getUpdates") {
      log.debug(`api → ${method}`, summarizeTelegramBody(method, body));
    } else {
      log.debug("api → getUpdates", {
        offset: body?.offset,
        timeout: body?.timeout,
      });
    }

    const res = await fetchImpl(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 409) {
      log.warn("api 409 conflict on getUpdates (another poller?)");
      throw new TelegramApiError(
        409,
        "Conflict: terminated by other getUpdates request",
      );
    }

    let payload: { ok: boolean; result?: T; description?: string };
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      log.error(`api ${method} non-JSON`, { status: res.status });
      throw new TelegramApiError(
        res.status,
        `Telegram ${method} returned non-JSON (${res.status})`,
      );
    }

    if (!res.ok || !payload.ok) {
      log.error(`api ${method} failed`, {
        status: res.status,
        description: payload.description,
        ms: Date.now() - started,
      });
      throw new TelegramApiError(
        res.status,
        payload.description ?? `Telegram ${method} failed (${res.status})`,
      );
    }

    if (method === "getUpdates") {
      const updates = (payload.result as TelegramUpdate[] | undefined) ?? [];
      if (updates.length > 0) {
        log.info(`getUpdates delivered ${updates.length}`, {
          ids: updates.map((u) => u.update_id),
          kinds: updates.map((u) => summarizeUpdate(u).kind),
          ms: Date.now() - started,
        });
        for (const u of updates) {
          log.debug("inbound update", summarizeUpdate(u));
        }
      } else {
        log.debug("getUpdates empty", { ms: Date.now() - started });
      }
    } else {
      log.debug(`api ← ${method} ok`, { ms: Date.now() - started });
    }

    return payload.result as T;
  }

  return {
    getMe: () => call<BotMe>("getMe"),

    getUpdates: (params: GetUpdatesParams) =>
      call<TelegramUpdate[]>("getUpdates", {
        offset: params.offset,
        timeout: params.timeout,
        limit: params.limit,
        allowed_updates: params.allowedUpdates,
      }),

    sendMessage: async (params: SendMessageParams) => {
      log.info("outbound sendMessage", {
        chatId: params.chatId,
        thread: params.messageThreadId,
        text: previewOutboundText(params.text),
        textLen: params.text.length,
        hasKeyboard: Boolean(params.replyMarkup),
      });
      const result = await call<{ message_id: number }>("sendMessage", {
        chat_id: params.chatId,
        text: params.text,
        message_thread_id: params.messageThreadId,
        reply_markup: params.replyMarkup,
        reply_to_message_id: params.replyToMessageId,
        parse_mode: params.parseMode,
        ...(params.disableNotification ? { disable_notification: true } : {}),
      });
      return { message_id: result.message_id };
    },

    sendChatAction: async (params: SendChatActionParams) => {
      log.debug("outbound sendChatAction", {
        chatId: params.chatId,
        thread: params.messageThreadId,
        action: params.action,
      });
      await call("sendChatAction", {
        chat_id: params.chatId,
        action: params.action,
        ...(params.messageThreadId !== undefined
          ? { message_thread_id: params.messageThreadId }
          : {}),
      });
    },

    editMessageText: async (params: EditMessageTextParams) => {
      log.info("outbound editMessageText", {
        chatId: params.chatId,
        messageId: params.messageId,
        text: previewOutboundText(params.text, 200),
        textLen: params.text.length,
      });
      await call("editMessageText", {
        chat_id: params.chatId,
        message_id: params.messageId,
        text: params.text,
        reply_markup: params.replyMarkup,
        parse_mode: params.parseMode,
      });
    },

    deleteMessage: async (params: DeleteMessageParams) => {
      log.info("outbound deleteMessage", {
        chatId: params.chatId,
        messageId: params.messageId,
      });
      await call("deleteMessage", {
        chat_id: params.chatId,
        message_id: params.messageId,
      });
    },

    editForumTopic: async (params: EditForumTopicParams) => {
      log.info("outbound editForumTopic", {
        chatId: params.chatId,
        thread: params.messageThreadId,
        name: params.name,
      });
      await call("editForumTopic", {
        chat_id: params.chatId,
        message_thread_id: params.messageThreadId,
        name: params.name,
        icon_custom_emoji_id: params.iconCustomEmojiId,
      });
    },

    createForumTopic: async (
      params: CreateForumTopicParams,
    ): Promise<ForumTopic> => {
      log.info("outbound createForumTopic", {
        chatId: params.chatId,
        name: params.name,
      });
      return call<ForumTopic>("createForumTopic", {
        chat_id: params.chatId,
        name: params.name,
        icon_color: params.iconColor,
        icon_custom_emoji_id: params.iconCustomEmojiId,
      });
    },

    answerCallbackQuery: async (params: AnswerCallbackQueryParams) => {
      log.debug("outbound answerCallbackQuery", {
        id: params.callbackQueryId.slice(0, 12),
        text: params.text,
      });
      await call("answerCallbackQuery", {
        callback_query_id: params.callbackQueryId,
        text: params.text,
        show_alert: params.showAlert,
      });
    },

    setMyCommands: async (params: SetMyCommandsParams) => {
      log.info("outbound setMyCommands", {
        count: params.commands.length,
        scope: params.scope ?? "default",
        languageCode: params.languageCode ?? "(none)",
        commands: params.commands.map((c) => c.command).join(" "),
      });
      await call("setMyCommands", {
        commands: params.commands,
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.languageCode
          ? { language_code: params.languageCode }
          : {}),
      });
    },

    deleteMyCommands: async (params: DeleteMyCommandsParams = {}) => {
      log.info("outbound deleteMyCommands", {
        scope: params.scope ?? "default",
        languageCode: params.languageCode ?? "(none)",
      });
      await call("deleteMyCommands", {
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.languageCode
          ? { language_code: params.languageCode }
          : {}),
      });
    },

    getMyCommands: async (
      params: GetMyCommandsParams = {},
    ): Promise<TelegramBotCommand[]> => {
      return call<TelegramBotCommand[]>("getMyCommands", {
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.languageCode
          ? { language_code: params.languageCode }
          : {}),
      });
    },

    getFile: async (fileId: string): Promise<TelegramFileInfo> => {
      return call<TelegramFileInfo>("getFile", { file_id: fileId });
    },

    downloadFile: async (fileId: string): Promise<Uint8Array> => {
      const info = await call<TelegramFileInfo>("getFile", { file_id: fileId });
      if (!info.file_path) {
        throw new Error("getFile returned no file_path");
      }
      const url = info.file_path.startsWith("http")
        ? info.file_path
        : `${filesRoot}/${info.file_path}`;
      log.info("download file", {
        fileId: fileId.slice(0, 12),
        size: info.file_size,
      });
      const res = await fetchImpl(url);
      if (!res.ok) {
        throw new TelegramApiError(
          res.status,
          `downloadFile failed (${res.status})`,
        );
      }
      return new Uint8Array(await res.arrayBuffer());
    },

    sendVoice: async (params: SendVoiceParams) => {
      log.info("outbound sendVoice", {
        chatId: params.chatId,
        thread: params.messageThreadId,
        bytes: params.data.byteLength,
      });
      return uploadMultipart<{ message_id: number }>(
        base,
        fetchImpl,
        "sendVoice",
        {
          chat_id: String(params.chatId),
          ...(params.messageThreadId !== undefined
            ? { message_thread_id: String(params.messageThreadId) }
            : {}),
          ...(params.caption ? { caption: params.caption } : {}),
          ...(params.replyToMessageId !== undefined
            ? { reply_to_message_id: String(params.replyToMessageId) }
            : {}),
          ...(params.disableNotification
            ? { disable_notification: "true" }
            : {}),
        },
        {
          field: "voice",
          filename: params.filename ?? "voice.ogg",
          contentType: params.filename?.endsWith(".mp3")
            ? "audio/mpeg"
            : "audio/ogg",
          data: params.data,
        },
      );
    },

    sendDocument: async (params: SendDocumentParams) => {
      log.info("outbound sendDocument", {
        chatId: params.chatId,
        thread: params.messageThreadId,
        filename: params.filename,
        bytes: params.data.byteLength,
      });
      return uploadMultipart<{ message_id: number }>(
        base,
        fetchImpl,
        "sendDocument",
        {
          chat_id: String(params.chatId),
          ...(params.messageThreadId !== undefined
            ? { message_thread_id: String(params.messageThreadId) }
            : {}),
          ...(params.caption ? { caption: params.caption } : {}),
          ...(params.disableNotification
            ? { disable_notification: "true" }
            : {}),
        },
        {
          field: "document",
          filename: params.filename,
          contentType: "application/octet-stream",
          data: params.data,
        },
      );
    },

    sendPhoto: async (params: SendPhotoParams) => {
      log.info("outbound sendPhoto", {
        chatId: params.chatId,
        thread: params.messageThreadId,
        filename: params.filename ?? "photo.jpg",
        bytes: params.data.byteLength,
      });
      return uploadMultipart<{ message_id: number }>(
        base,
        fetchImpl,
        "sendPhoto",
        {
          chat_id: String(params.chatId),
          ...(params.messageThreadId !== undefined
            ? { message_thread_id: String(params.messageThreadId) }
            : {}),
          ...(params.caption ? { caption: params.caption } : {}),
          ...(params.disableNotification
            ? { disable_notification: "true" }
            : {}),
        },
        {
          field: "photo",
          filename: params.filename ?? "photo.jpg",
          contentType: guessImageContentType(params.filename ?? "photo.jpg"),
          data: params.data,
        },
      );
    },
  };
}

function guessImageContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

async function uploadMultipart<T>(
  base: string,
  fetchImpl: typeof fetch,
  method: string,
  fields: Record<string, string>,
  file: {
    field: string;
    filename: string;
    contentType: string;
    data: Uint8Array;
  },
): Promise<T> {
  const boundary = `----acpbot${Date.now().toString(16)}`;
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      ),
    );
  }
  chunks.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  chunks.push(file.data);
  chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));
  const body = concatBytes(chunks);
  const res = await fetchImpl(`${base}/${method}`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const payload = (await res.json()) as {
    ok: boolean;
    result?: T;
    description?: string;
  };
  if (!res.ok || !payload.ok) {
    throw new TelegramApiError(
      res.status,
      payload.description ?? `${method} failed`,
    );
  }
  return payload.result as T;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/**
 * Log preview for outbound text. Prefer first + last so long multi-line
 * errors (e.g. OAuth) are not cut mid-sentence in logs only.
 * The full `text` is still sent to Telegram unchanged.
 */
export function previewOutboundText(text: string, max = 400): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  const tail = max - head - 5;
  return `${text.slice(0, head)}\n…\n${text.slice(-tail)}`;
}

function summarizeTelegramBody(
  method: string,
  body?: Record<string, unknown>,
): Record<string, unknown> {
  if (!body) return { method };
  const out: Record<string, unknown> = { method };
  for (const key of [
    "chat_id",
    "message_thread_id",
    "message_id",
    "offset",
    "timeout",
    "name",
  ]) {
    if (key in body) out[key] = body[key];
  }
  if (typeof body.text === "string") {
    out.text = previewOutboundText(body.text, 200);
    out.text_len = body.text.length;
  }
  if (body.reply_markup) out.has_reply_markup = true;
  return out;
}
