import { describe, expect, test } from "bun:test";
import {
  assertBotMeHasTopics,
  TopicsDisabledError,
  verifyBotTokenTopics,
} from "../src/env/telegram-topics";
import { TelegramApiError } from "../src/env/types";
import type { BotMe } from "../src/env/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function me(partial: Partial<BotMe> = {}): BotMe {
  return {
    id: 1,
    is_bot: true,
    first_name: "acpbot",
    username: "acpbot_bot",
    has_topics_enabled: true,
    ...partial,
  };
}

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => jsonResponse(body, status)) as typeof fetch;
}

describe("telegram topics / Threaded Mode", () => {
  test("assertBotMeHasTopics throws when flag is false or missing", () => {
    expect(() =>
      assertBotMeHasTopics(me({ has_topics_enabled: false })),
    ).toThrow(TopicsDisabledError);
    const missing: BotMe = {
      id: 1,
      is_bot: true,
      first_name: "acpbot",
    };
    expect(() => assertBotMeHasTopics(missing)).toThrow(TopicsDisabledError);
    expect(() =>
      assertBotMeHasTopics(me({ has_topics_enabled: true })),
    ).not.toThrow();
  });

  test("error names Threaded Mode and acpbot, not tacp", () => {
    const err = new TopicsDisabledError();
    expect(err.message).toMatch(/Threaded Mode/);
    expect(err.message).toMatch(/BotFather/);
    expect(err.message).toMatch(/acpbot/);
    expect(err.message).not.toMatch(/tacp/);
  });

  test("verifyBotTokenTopics fails closed when getMe.has_topics_enabled is false", async () => {
    await expect(
      verifyBotTokenTopics({
        token: "1:TEST",
        fetchImpl: fakeFetch({
          ok: true,
          result: me({ has_topics_enabled: false }),
        }),
      }),
    ).rejects.toBeInstanceOf(TopicsDisabledError);
  });

  test("verifyBotTokenTopics returns me when Threaded Mode is on", async () => {
    const got = await verifyBotTokenTopics({
      token: "1:TEST",
      fetchImpl: fakeFetch({
        ok: true,
        result: me({ username: "ok_bot", has_topics_enabled: true }),
      }),
    });
    expect(got.username).toBe("ok_bot");
  });

  test("verifyBotTokenTopics surfaces Telegram auth errors", async () => {
    await expect(
      verifyBotTokenTopics({
        token: "bad",
        fetchImpl: fakeFetch({ ok: false, description: "Unauthorized" }, 401),
      }),
    ).rejects.toBeInstanceOf(TelegramApiError);
  });
});
