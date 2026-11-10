/** Selective notifications and durable inboxes for existing CLI sessions.
 * Only the Telegram worker polls the bot. MCP clients never receive its token.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import type { Store, TelegramPort, TelegramUpdate } from "../env/types";
import { initialTopicName } from "./status";
import { messageHasMedia, messageTextOrCaption, prepareAgentMedia } from "./media";
import { basenameOf, resolvePathUnderRepo, TELEGRAM_DOCUMENT_MAX_BYTES, TELEGRAM_PHOTO_MAX_BYTES } from "../mcp/repo-path";

type InboxMessage = { id: number; telegram_message_id: number; text: string; received_at: number; question_id?: string };
type Question = { id: string; request_id: string; message_id: number; after_id: number; text: string; answer?: InboxMessage; cancelled?: boolean };
type Binding = {
  id: string; agent: string; session_id: string; name: string; repo_root: string;
  owner_id: number; chat_id: number; topic_id: number; next_id: number;
  inbox: InboxMessage[]; seen_updates: number[]; questions: Question[];
  last_delivered_id?: number;
};
type State = { bindings: Record<string, Binding> };
const STORE_KEY = "telegram:external-bindings:v1";
const MAX_INBOX = 1000;

function string(body: Record<string, unknown>, key: string, max = 4000): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${key} must be nonempty (max ${max} characters)`);
  return value.trim();
}

export function createExternalBridge(options: {
  store: Store; telegram: TelegramPort;
  operator: () => { userId: number; chatId: number | undefined };
}) {
  let tail: Promise<unknown> = Promise.resolve();
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const current = tail.then(fn, fn);
    tail = current.catch(() => {});
    return current;
  }
  const load = async (): Promise<State> => (await options.store.load<State>(STORE_KEY)) ?? { bindings: {} };
  const save = (state: State) => options.store.save(STORE_KEY, state);
  function owner() {
    const op = options.operator();
    if (op.userId <= 0 || op.chatId === undefined) throw new Error("Pair the Telegram operator first");
    return { userId: op.userId, chatId: op.chatId };
  }
  function binding(state: State, body: Record<string, unknown>): Binding {
    const b = state.bindings[string(body, "binding_id", 100)];
    const op = owner();
    if (!b || b.owner_id !== op.userId || b.chat_id !== op.chatId) throw new Error("Unknown binding; call telegram_connect for this session");
    return b;
  }
  async function connect(body: Record<string, unknown>) {
    return locked(async () => {
      const op = owner();
      const agent = string(body, "agent", 40);
      if (!["mimo", "codex"].includes(agent)) throw new Error("agent must be mimo or codex");
      const sessionId = string(body, "session_id", 200);
      const name = string(body, "name", 100);
      const root = await realpath(string(body, "repo_root", 4096));
      if (!(await stat(root)).isDirectory()) throw new Error("repo_root must be a directory");
      const id = createHash("sha256").update(`${op.userId}\0${agent}\0${sessionId}`).digest("hex").slice(0, 32);
      const state = await load();
      let b = state.bindings[id];
      if (b) {
        if (b.repo_root !== root || b.chat_id !== op.chatId) throw new Error("Session identity already bound to another workspace/chat; use a distinct session_id");
        if (b.name !== name) {
          await options.telegram.editForumTopic({ chatId: b.chat_id, messageThreadId: b.topic_id, name: initialTopicName("", name, agent) });
          b.name = name;
          await save(state);
        }
      } else {
        const topic = await options.telegram.createForumTopic({ chatId: op.chatId, name: initialTopicName("", name, agent) });
        b = { id, agent, session_id: sessionId, name, repo_root: root,
          owner_id: op.userId, chat_id: op.chatId, topic_id: topic.message_thread_id,
          next_id: 1, inbox: [], seen_updates: [], questions: [] };
        state.bindings[id] = b;
        await save(state);
        await options.telegram.sendMessage({ chatId: b.chat_id, messageThreadId: b.topic_id,
          text: `${agent === "mimo" ? "MiMo" : "Codex"} · ${name}\nSelective notifications from your existing session. Replies and commands wait in its MCP inbox until the agent checks it.`, disableNotification: true });
      }
      return { binding_id: b.id, topic_id: b.topic_id, session_id: b.session_id,
        last_message_id: b.next_id - 1, mode: "selective_notifications", inbox_cursor: 0 };
    });
  }
  async function read(body: Record<string, unknown>, questionId?: string) {
    return locked(async () => {
    const state = await load();
    const b = binding(state, body);
    // Recover an already queued plain-topic answer if Telegram supplied its
    // implicit reply-to-topic-root rather than the question's message ID.
    const question = questionId ? b.questions.find(q => q.id === questionId) : undefined;
    if (question && !question.answer && !question.cancelled) {
      const answer = b.inbox.find(m => m.id > question.after_id && !m.question_id);
      if (answer) {
        answer.question_id = question.id; question.answer = answer;
        await save(state);
      }
    }
    const after = typeof body.after_id === "number" ? body.after_id : 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("after_id must be a nonnegative integer");
    let messages = b.inbox.filter(m => m.id > after && (!questionId || m.question_id === questionId)).slice(0, 100);
    const savedAnswer = questionId ? b.questions.find(q => q.id === questionId)?.answer : undefined;
    if (!messages.length && savedAnswer && savedAnswer.id > after) messages = [savedAnswer];
    const latest = messages.at(-1);
    if (latest && latest.id > (b.last_delivered_id ?? 0)) {
      try {
        await options.telegram.sendMessage({ chatId: b.chat_id, messageThreadId: b.topic_id,
          replyToMessageId: latest.telegram_message_id, disableNotification: true,
          text: `✓ Передано через MCP: ${b.agent === "mimo" ? "MiMo" : "Codex"} · ${b.name}` });
        b.last_delivered_id = latest.id;
        await save(state);
      } catch { /* A receipt failure must not prevent the agent receiving input. */ }
    }
    return { binding_id: b.id, messages, next_after_id: messages.at(-1)?.id ?? after,
      cancelled: questionId ? b.questions.find(q => q.id === questionId)?.cancelled === true : false,
      history_truncated: after < (b.inbox[0]?.id ?? 1) - 1 };
    });
  }
  async function receive(body: Record<string, unknown>, questionId?: string) {
    const seconds = typeof body.wait_seconds === "number" ? body.wait_seconds : 0;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 45) throw new Error("wait_seconds must be between 0 and 45");
    const deadline = Date.now() + seconds * 1000;
    while (true) {
      const result = await read(body, questionId);
      if (result.cancelled || result.messages.length || Date.now() >= deadline) return { ...result, timed_out: !result.cancelled && result.messages.length === 0 };
      await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    }
  }
  async function ask(body: Record<string, unknown>) {
    const question = string(body, "question", 3500);
    const requestId = string(body, "request_id", 100);
    const q = await locked(async () => {
      const state = await load(); const b = binding(state, body);
      const existing = b.questions.find(q => q.request_id === requestId);
      if (existing) {
        if (existing.text !== question) throw new Error("request_id was already used for a different question");
        return existing;
      }
      const unanswered = b.questions.find(q => !q.answer && !q.cancelled);
      if (unanswered) throw new Error(`A question is already awaiting an answer: ${unanswered.id}. Use telegram_wait_reply.`);
      const sent = await options.telegram.sendMessage({ chatId: b.chat_id, messageThreadId: b.topic_id,
        text: `❓ ${question}\n\nReply to this message or write your answer in this topic.` });
      const q = { id: randomUUID(), request_id: requestId, message_id: sent.message_id, after_id: b.next_id - 1, text: question };
      b.questions.push(q); b.questions = b.questions.slice(-100);
      await save(state); return q;
    });
    const result = await receive({ ...body, after_id: q.after_id, wait_seconds: body.wait_seconds ?? 45 }, q.id);
    return { question_id: q.id, ...result };
  }
  async function request(action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (action === "connect") return connect(body);
    if (action === "receive") return receive(body);
    if (action === "ask") return ask(body);
    if (action === "cancel-question") return locked(async () => {
      const state = await load(); const b = binding(state, body);
      const q = b.questions.find(q => q.id === string(body, "question_id", 100));
      if (!q) throw new Error("Unknown question_id");
      q.cancelled = true; await save(state); return { question_id: q.id, cancelled: true };
    });
    if (action === "wait-reply") {
      const state = await load(); const b = binding(state, body);
      const q = b.questions.find(q => q.id === string(body, "question_id", 100));
      if (!q) throw new Error("Unknown question_id");
      return { question_id: q.id, ...await receive({ ...body, after_id: body.after_id ?? q.after_id, wait_seconds: body.wait_seconds ?? 45 }, q.id) };
    }
    const state = await load(); const b = binding(state, body);
    if (action === "notify") {
      const sent = await options.telegram.sendMessage({ chatId: b.chat_id, messageThreadId: b.topic_id,
        text: string(body, "text"), disableNotification: body.silent === true });
      return { message_id: sent.message_id };
    }
    if (action === "photo" || action === "file") {
      const path = resolvePathUnderRepo(b.repo_root, string(body, "path", 4096));
      if (!path.ok) throw new Error(path.error);
      if (path.size > (action === "photo" ? TELEGRAM_PHOTO_MAX_BYTES : TELEGRAM_DOCUMENT_MAX_BYTES)) throw new Error("File exceeds Telegram upload limit");
      const params = { chatId: b.chat_id, messageThreadId: b.topic_id, data: new Uint8Array(await readFile(path.abs)), filename: basenameOf(path.abs),
        ...(typeof body.caption === "string" ? { caption: body.caption.slice(0, 1024) } : {}) };
      const send = action === "photo" ? options.telegram.sendPhoto : options.telegram.sendDocument;
      if (!send) throw new Error("Telegram media upload is unavailable");
      const sent = await send.call(options.telegram, params);
      return { message_id: sent.message_id, bytes: path.size };
    }
    throw new Error("Unknown external bridge action");
  }
  async function handleUpdate(update: TelegramUpdate): Promise<boolean> {
    const msg = update.message ?? update.edited_message;
    if (!msg?.message_thread_id) return false;
    return locked(async () => {
      const state = await load();
      const b = Object.values(state.bindings).find(b => b.chat_id === msg.chat.id && b.topic_id === msg.message_thread_id);
      if (!b) return false;
      const op = owner();
      if (msg.from?.id !== op.userId || b.owner_id !== op.userId) return true;
      if (b.seen_updates.includes(update.update_id)) return true;
      let text = messageTextOrCaption(msg);
      if (messageHasMedia(msg)) {
        text = (await prepareAgentMedia({ msg, telegram: options.telegram, sessionCwd: b.repo_root, acpMediaAttachments: false })).text;
      }
      if (!text) return true;
      const repliedTo = (msg as typeof msg & { reply_to_message?: { message_id: number } }).reply_to_message?.message_id;
      const pending = b.questions.filter(q => !q.answer && !q.cancelled);
      const explicitQuestion = b.questions.find(q => q.message_id === repliedTo);
      const q = explicitQuestion ?? (pending.length === 1 ? pending[0] : undefined);
      const incoming = { id: b.next_id++, telegram_message_id: msg.message_id, text, received_at: Date.now(), ...(q ? { question_id: q.id } : {}) };
      b.inbox.push(incoming);
      if (q && !q.answer) q.answer = incoming;
      b.inbox = b.inbox.slice(-MAX_INBOX);
      b.seen_updates.push(update.update_id); b.seen_updates = b.seen_updates.slice(-2000);
      await save(state);
      return true;
    });
  }
  return { request, handleUpdate };
}
