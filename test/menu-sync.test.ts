import { beforeEach, describe, expect, test } from "bun:test";
import {
  menuFingerprint,
  telegramMenuCommands,
} from "../src/core/commands";
import {
  resetMenuSyncStateForTests,
  syncTelegramSlashMenu,
} from "../src/core/menu-sync";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import { fakeTelegram } from "../src/env/fake-telegram";

describe("telegram menu commands", () => {
  test("builds BotCommand list without leading slashes", () => {
    const menu = telegramMenuCommands();
    // Full surface: lobby + topic (Telegram has no per-topic menu scope)
    expect(menu.length).toBeGreaterThanOrEqual(8);
    for (const c of menu) {
      expect(c.command).not.toMatch(/^\//);
      expect(c.command).toMatch(/^[a-z0-9_]+$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
    const names = menu.map((c) => c.command);
    expect(names).toContain("ping");
    expect(names).toContain("new");
    expect(names).toContain("sessions");
    expect(names).toContain("help");
    // Topic commands must appear so operators can discover them in “/”
    expect(names).toContain("skills");
    expect(names).toContain("cancel");
    expect(names).toContain("mode");
    expect(names).toContain("plan");
    expect(names).toContain("build");
    expect(names).toContain("mcp");
    expect(names).toContain("status");
  });

  test("fingerprint changes when description changes", () => {
    const a = telegramMenuCommands();
    const b = a.map((c, i) =>
      i === 0 ? { ...c, description: "changed" } : c,
    );
    expect(menuFingerprint(a)).not.toBe(menuFingerprint(b));
  });
});

describe("syncTelegramSlashMenu", () => {
  beforeEach(() => {
    resetMenuSyncStateForTests();
  });

  test("first sync clears then sets; second identical sync is a no-op", async () => {
    const tg = fakeTelegram();
    await syncTelegramSlashMenu(tg, { force: true });

    const deletes = tg.outbound.filter((c) => c.method === "deleteMyCommands");
    const sets = tg.outbound.filter((c) => c.method === "setMyCommands");
    // 2 scopes × 2 langs
    expect(deletes.length).toBe(4);
    expect(sets.length).toBe(4);

    const firstSet = sets[0];
    expect(firstSet?.method).toBe("setMyCommands");
    if (firstSet?.method === "setMyCommands") {
      expect(firstSet.params.commands.map((c) => c.command)).toEqual(
        telegramMenuCommands().map((c) => c.command),
      );
    }

    tg.clearOutbound();
    await syncTelegramSlashMenu(tg);
    expect(
      tg.outbound.filter(
        (c) =>
          c.method === "setMyCommands" || c.method === "deleteMyCommands",
      ),
    ).toHaveLength(0);
  });

  test("force re-runs wipe even when menu unchanged", async () => {
    const tg = fakeTelegram();
    await syncTelegramSlashMenu(tg, { force: true });
    tg.clearOutbound();
    await syncTelegramSlashMenu(tg, { force: true });
    expect(
      tg.outbound.filter((c) => c.method === "deleteMyCommands"),
    ).toHaveLength(4);
    expect(
      tg.outbound.filter((c) => c.method === "setMyCommands"),
    ).toHaveLength(4);
  });

  test("daemon run syncs menu on startup", async () => {
    resetMenuSyncStateForTests();
    const env = createFakeEnvironment({
      config: { operatorUserId: 42 },
    });
    const daemon = createDaemon(env, {
      pollTimeoutSec: 0,
      conflictBackoffMs: 1,
    });
    const ac = new AbortController();
    const runP = daemon.run(ac.signal);
    // Let startup finish one empty getUpdates cycle
    await Bun.sleep(30);
    ac.abort();
    await runP.catch(() => {});

    const sets = env.telegram.outbound.filter(
      (c) => c.method === "setMyCommands",
    );
    expect(sets.length).toBeGreaterThanOrEqual(1);
    const first = sets[0];
    if (first?.method === "setMyCommands") {
      expect(first.params.commands.some((c) => c.command === "new")).toBe(
        true,
      );
    }
  });
});
