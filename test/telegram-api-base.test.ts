import { describe, expect, test } from "bun:test";
import { telegramBotApiBase } from "../src/env/env-keys";
import { realTelegram } from "../src/env/real-telegram";

describe("telegramBotApiBase", () => {
  test("unset env returns undefined", () => {
    expect(telegramBotApiBase("tok", {})).toBeUndefined();
  });

  test("joins root and token without a trailing slash on root", () => {
    expect(
      telegramBotApiBase("abc:def", {
        ACPBOT_TELEGRAM_API_BASE: "http://127.0.0.1:9/",
      }),
    ).toBe("http://127.0.0.1:9/botabc:def");
  });
});

describe("realTelegram apiBase", () => {
  test("getMe and sendMessage hit the override, not api.telegram.org", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push(`${req.method} ${url.pathname}`);
        if (url.pathname.endsWith("/getMe")) {
          return Response.json({
            ok: true,
            result: {
              id: 1,
              is_bot: true,
              first_name: "acpbot",
              has_topics_enabled: true,
            },
          });
        }
        if (url.pathname.endsWith("/sendMessage")) {
          return Response.json({ ok: true, result: { message_id: 7 } });
        }
        return Response.json({ ok: false, description: "nope" }, { status: 404 });
      },
    });
    try {
      const tg = realTelegram({
        token: "999999:verify-test-token",
        apiBase: `http://127.0.0.1:${server.port}/bot999999:verify-test-token`,
      });
      const me = await tg.getMe();
      expect(me.has_topics_enabled).toBe(true);
      const sent = await tg.sendMessage({ chatId: 1000, text: "pong" });
      expect(sent.message_id).toBe(7);
      expect(seen.some((s) => s.endsWith("/getMe"))).toBe(true);
      expect(seen.some((s) => s.endsWith("/sendMessage"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
