#!/usr/bin/env bun

type Update = Record<string, unknown> & { update_id: number };

type Outbound = {
  at: string;
  method: string;
  body: unknown;
  result: unknown;
};

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return args[i + 1]!;
  return fallback;
}

const bind = flag("bind", "127.0.0.1");
const port = Number(flag("port", "0"));
const token = flag("token", "999999:verify-acpbot-mock-token-xxxxxxxx");

const pending: Update[] = [];
const outbound: Outbound[] = [];
let nextUpdateId = 1;
let nextMessageId = 1;
let nextThreadId = 100;
const waiters: Array<{
  offset: number;
  resolve: (u: Update[]) => void;
  timer: ReturnType<typeof setTimeout>;
}> = [];

function ok(result: unknown): Response {
  return Response.json({ ok: true, result });
}

function fail(status: number, description: string): Response {
  return Response.json({ ok: false, description }, { status });
}

function deliver(offset: number): Update[] {
  const out = pending.filter((u) => u.update_id >= offset);
  for (const u of out) {
    const i = pending.indexOf(u);
    if (i >= 0) pending.splice(i, 1);
  }
  return out;
}

function wake(): void {
  for (const w of [...waiters]) {
    const got = deliver(w.offset);
    if (got.length === 0) continue;
    clearTimeout(w.timer);
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(got);
  }
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function lobbyUpdate(input: Record<string, unknown>): Update {
  if (typeof input.update_id === "number" && input.message) {
    return input as Update;
  }
  const update_id =
    typeof input.update_id === "number" ? input.update_id : nextUpdateId++;
  const userId = Number(input.userId ?? input.user_id ?? 42);
  const chatId = Number(input.chatId ?? input.chat_id ?? 1000);
  const text = String(input.text ?? "/ping");
  const thread = input.message_thread_id ?? input.messageThreadId;
  return {
    update_id,
    message: {
      message_id: Number(input.message_id ?? update_id),
      date: Math.floor(Date.now() / 1000),
      text,
      from: {
        id: userId,
        is_bot: false,
        first_name: String(input.first_name ?? "op"),
        username: String(input.username ?? "op"),
      },
      chat: { id: chatId, type: "private" },
      ...(thread !== undefined
        ? {
            message_thread_id: Number(thread),
            is_topic_message: true,
          }
        : {}),
    },
  };
}

function handleMethod(method: string, body: Record<string, unknown>): unknown {
  switch (method) {
    case "getMe":
      return {
        id: 1,
        is_bot: true,
        first_name: "acpbot",
        username: "acpbot_verify_bot",
        has_topics_enabled: true,
      };
    case "getUpdates": {
      const offset = Number(body.offset ?? 0);
      const timeoutSec = Number(body.timeout ?? 0);
      const ready = deliver(offset);
      if (ready.length > 0 || timeoutSec <= 0) return ready;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(deliver(offset));
        }, timeoutSec * 1000);
        waiters.push({
          offset,
          resolve,
          timer,
        });
      });
    }
    case "sendMessage": {
      const message_id = nextMessageId++;
      const result = { message_id, chat: { id: body.chat_id }, text: body.text };
      outbound.push({
        at: new Date().toISOString(),
        method,
        body,
        result,
      });
      return result;
    }
    case "sendChatAction":
    case "editMessageText":
    case "deleteMessage":
    case "answerCallbackQuery":
    case "editForumTopic":
    case "setMyCommands":
    case "deleteMyCommands":
      outbound.push({
        at: new Date().toISOString(),
        method,
        body,
        result: true,
      });
      return true;
    case "getMyCommands":
      outbound.push({
        at: new Date().toISOString(),
        method,
        body,
        result: [],
      });
      return [];
    case "createForumTopic": {
      const message_thread_id = nextThreadId++;
      const result = {
        message_thread_id,
        name: body.name,
        icon_color: body.icon_color ?? 0x6fb9f0,
      };
      outbound.push({
        at: new Date().toISOString(),
        method,
        body,
        result,
      });
      return result;
    }
    case "getFile":
      return {
        file_id: body.file_id,
        file_path: `fake/${body.file_id}`,
        file_size: 4,
      };
    default:
      outbound.push({
        at: new Date().toISOString(),
        method,
        body,
        result: { message_id: nextMessageId++ },
      });
      return { message_id: nextMessageId - 1 };
  }
}

const server = Bun.serve({
  hostname: bind,
  port,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/_mock/health") {
      return Response.json({
        ok: true,
        token,
        pending: pending.length,
        outbound: outbound.length,
      });
    }
    if (path === "/_mock/outbound") {
      return Response.json({ ok: true, outbound });
    }
    if (path === "/_mock/reset-outbound" && req.method === "POST") {
      outbound.length = 0;
      return Response.json({ ok: true });
    }
    if (path === "/_mock/inject" && req.method === "POST") {
      const body = await readBody(req);
      const updates = Array.isArray(body.updates)
        ? (body.updates as Record<string, unknown>[]).map(lobbyUpdate)
        : [lobbyUpdate(body)];
      pending.push(...updates);
      wake();
      return Response.json({
        ok: true,
        injected: updates.map((u) => u.update_id),
      });
    }

    const m = path.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
    if (!m) return fail(404, "not found");
    if (m[1] !== token) return fail(401, "unauthorized");
    const method = m[2]!;
    const body = await readBody(req);
    const result = await handleMethod(method, body);
    return ok(result);
  },
});

const addr = `http://${bind}:${server.port}`;
console.log(`telegram-mock listening ${addr}`);
console.log(`ACPBOT_TELEGRAM_API_BASE=${addr}`);
