import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFakeComputerBackend,
  FAKE_SCREENSHOT_JPEG,
} from "../src/computer/fake";
import { INPUT_NOT_ENABLED } from "../src/computer/backend";
import {
  createComputerSupervisor,
  type ComputerOwnerConn,
  type ComputerSlotView,
} from "../src/computer/supervisor";

function liveConn(): ComputerOwnerConn {
  return { destroyed: false };
}

describe("fake computer backend", () => {
  test("screenshot returns fixture JPEG without touching the filesystem", async () => {
    const backend = createFakeComputerBackend();
    const shot = await backend.screenshot({});
    expect(shot.jpeg).toEqual(FAKE_SCREENSHOT_JPEG);
    expect(shot.width).toBe(1);
    expect(shot.height).toBe(1);
  });

  test("pointer / key / type / navigate throw input_not_enabled", async () => {
    const backend = createFakeComputerBackend();
    await expect(backend.pointer({ kind: "click", x: 1, y: 1 })).rejects.toMatchObject({
      code: INPUT_NOT_ENABLED,
    });
    await expect(backend.key({ key: "a" })).rejects.toMatchObject({
      code: INPUT_NOT_ENABLED,
    });
    await expect(backend.typeText("hi")).rejects.toMatchObject({
      code: INPUT_NOT_ENABLED,
    });
    await expect(backend.navigate({ url: "https://example.com" })).rejects.toMatchObject({
      code: INPUT_NOT_ENABLED,
    });
    const probe = await backend.probe();
    expect(probe.backend).toBe("fake");
    expect(probe.inputEnabled).toBe(false);
    expect(probe.ok).toBe(true);
  });
});

describe("computer supervisor", () => {
  async function setup(opts?: {
    enabled?: boolean;
    computerAllowed?: boolean;
    turnSource?: ComputerSlotView["turnSource"];
    expiresAt?: number;
    owner?: ComputerOwnerConn | null;
    grantConn?: ComputerOwnerConn;
  }) {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-comp-"));
    const owner = opts?.owner === undefined ? liveConn() : opts.owner;
    const grantConn = opts?.grantConn ?? owner ?? liveConn();
    const slot: ComputerSlotView = {
      slotKey: "demo/box",
      owner,
      computerAllowed: opts?.computerAllowed ?? true,
      ...(opts && "turnSource" in opts
        ? { turnSource: opts.turnSource }
        : { turnSource: "operator" }),
    };
    const frames: Array<{ frameId: string; jpegBase64: string }> = [];
    const supervisor = createComputerSupervisor({
      backend: createFakeComputerBackend(),
      getConfig: () => ({ enabled: opts?.enabled ?? true }),
      getSlot: (k) => (k === slot.slotKey ? slot : undefined),
      publishFrame: (f) => {
        frames.push({ frameId: f.frameId, jpegBase64: f.jpegBase64 });
      },
      stateDir: dir,
    });
    supervisor.applyGrant(slot.slotKey, grantConn, {
      enabled: true,
      watch: false,
      expiresAt: opts?.expiresAt ?? 0,
      hostId: "local",
    });
    return { dir, slot, supervisor, frames, grantConn, owner };
  }

  test("screenshot succeeds for granted operator slot", async () => {
    const { supervisor, frames, dir } = await setup();
    const out = await supervisor.act("demo/box", { type: "screenshot" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.frameId).toBeTruthy();
      expect(out.width).toBe(1);
      expect(out.jpeg).toEqual(FAKE_SCREENSHOT_JPEG);
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]!.jpegBase64).not.toContain("framePath");
    await rm(dir, { recursive: true, force: true });
  });

  test("refuses when disabled / no grant / not allowed / no owner / wrong conn / bad source", async () => {
    {
      const { supervisor, dir } = await setup({ enabled: false });
      expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
        "disabled",
      );
      await rm(dir, { recursive: true, force: true });
    }
    {
      const { supervisor, dir } = await setup();
      supervisor.abort("demo/box");
      expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
        "no_grant",
      );
      await rm(dir, { recursive: true, force: true });
    }
    {
      const { supervisor, dir } = await setup({ computerAllowed: false });
      expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
        "not_allowed",
      );
      await rm(dir, { recursive: true, force: true });
    }
    {
      const { supervisor, dir } = await setup({ owner: null });
      expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
        "no_owner",
      );
      await rm(dir, { recursive: true, force: true });
    }
    {
      const owner = liveConn();
      const other = liveConn();
      const { supervisor, dir } = await setup({ owner, grantConn: other });
      expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
        "wrong_conn",
      );
      await rm(dir, { recursive: true, force: true });
    }
    {
      const { supervisor, dir } = await setup({ turnSource: "schedule" });
      expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
        "bad_source",
      );
      await rm(dir, { recursive: true, force: true });
    }
    {
      const { supervisor, dir } = await setup({ turnSource: undefined });
      expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
        "bad_source",
      );
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("owner disconnect drops the memory grant", async () => {
    const { supervisor, grantConn, dir } = await setup();
    supervisor.onOwnerDisconnect(grantConn!);
    expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
      "no_grant",
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("expired grant is dropped", async () => {
    const { supervisor, dir } = await setup({ expiresAt: 1 });
    expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
      "expired",
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("budget exhausts after max_actions_per_turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-comp-bud-"));
    const owner = liveConn();
    const slot: ComputerSlotView = {
      slotKey: "demo/box",
      owner,
      computerAllowed: true,
      turnSource: "operator",
    };
    const supervisor = createComputerSupervisor({
      backend: createFakeComputerBackend(),
      getConfig: () => ({ enabled: true, maxActionsPerTurn: 2, minActionIntervalMs: 0 }),
      getSlot: () => slot,
      publishFrame: () => {},
      stateDir: dir,
    });
    supervisor.applyGrant("demo/box", owner, {
      enabled: true,
      watch: false,
      expiresAt: 0,
      hostId: "local",
    });
    expect((await supervisor.act("demo/box", { type: "screenshot" })).ok).toBe(true);
    expect((await supervisor.act("demo/box", { type: "screenshot" })).ok).toBe(true);
    expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
      "budget",
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("click / type fail closed with input_not_enabled", async () => {
    const { supervisor, dir } = await setup();
    expect((await supervisor.act("demo/box", { type: "click", x: 1, y: 1 })).error).toBe(
      "input_not_enabled",
    );
    expect((await supervisor.act("demo/box", { type: "type", text: "hi" })).error).toBe(
      "input_not_enabled",
    );
    expect(
      (await supervisor.act("demo/box", { type: "navigate", url: "https://x.test" }))
        .error,
    ).toBe("input_not_enabled");
    await rm(dir, { recursive: true, force: true });
  });

  test("audit has no pixels or imageBase64", async () => {
    const { supervisor, dir } = await setup();
    await supervisor.act("demo/box", { type: "screenshot" });
    const text = await readFile(join(dir, "computer-audit.jsonl"), "utf8");
    expect(text).toContain('"action":"screenshot"');
    expect(text).not.toContain("imageBase64");
    expect(text).not.toMatch(/\/9j\//);
    expect(text).not.toContain("ffd8");
    await rm(dir, { recursive: true, force: true });
  });
});
