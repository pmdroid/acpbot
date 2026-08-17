import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFakeComputerBackend,
  FAKE_SCREENSHOT_JPEG,
} from "../src/computer/fake";
import {
  ComputerBackendError,
  INPUT_NOT_ENABLED,
  type ComputerUseBackend,
  type ScreenshotResult,
} from "../src/computer/backend";
import {
  createComputerSupervisor,
  type ComputerOwnerConn,
  type ComputerSlotView,
} from "../src/computer/supervisor";
import {
  decodeJpeg,
  encodeJpeg,
} from "../src/computer/annotate";

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

  test("turn abort refuses with abort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-comp-abort-"));
    const owner = liveConn();
    const slot: ComputerSlotView = {
      slotKey: "demo/box",
      owner,
      computerAllowed: true,
      turnSource: "operator",
      turnAbort: { aborted: true },
    };
    const supervisor = createComputerSupervisor({
      backend: createFakeComputerBackend(),
      getConfig: () => ({ enabled: true, minActionIntervalMs: 0 }),
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
    expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
      "abort",
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("min interval refuses a second screenshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-comp-int-"));
    const owner = liveConn();
    const slot: ComputerSlotView = {
      slotKey: "demo/box",
      owner,
      computerAllowed: true,
      turnSource: "operator",
    };
    const supervisor = createComputerSupervisor({
      backend: createFakeComputerBackend(),
      getConfig: () => ({ enabled: true, minActionIntervalMs: 60_000 }),
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
    expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
      "interval",
    );
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

  test("ttl timer drops grant without a subsequent action", async () => {
    const { supervisor, dir } = await setup({ expiresAt: Date.now() + 50 });
    expect(supervisor.getGrant("demo/box")).toBeDefined();
    await Bun.sleep(120);
    expect(supervisor.getGrant("demo/box")).toBeUndefined();
    expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
      "no_grant",
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("click publishes annotated Telegram copy; agent jpeg stays clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-comp-ann-"));
    const owner = liveConn();
    const slot: ComputerSlotView = {
      slotKey: "demo/box",
      owner,
      computerAllowed: true,
      turnSource: "operator",
    };
    const w = 64;
    const h = 48;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4 + 2] = 180;
      data[i * 4 + 3] = 255;
    }
    const fixture = encodeJpeg({ data, width: w, height: h }, 90);
    const frames: Array<{ jpegBase64: string; width: number; height: number }> =
      [];
    const backend = inputStubBackend(fixture, w, h);
    const supervisor = createComputerSupervisor({
      backend,
      getConfig: () => ({ enabled: true, minActionIntervalMs: 0, jpegQuality: 90 }),
      getSlot: () => slot,
      publishFrame: (f) => {
        frames.push({
          jpegBase64: f.jpegBase64,
          width: f.width,
          height: f.height,
        });
      },
      stateDir: dir,
    });
    supervisor.applyGrant("demo/box", owner, {
      enabled: true,
      watch: false,
      expiresAt: 0,
      hostId: "local",
    });
    const shot = await supervisor.act("demo/box", { type: "screenshot" });
    expect(shot.ok).toBe(true);
    if (shot.ok) {
      expect(shot.width).toBe(w);
      expect(shot.height).toBe(h);
      const agent = decodeJpeg(shot.jpeg!);
      const [ar] = pixel(agent, 20, 16);
      expect(ar).toBeLessThan(80);
    }
    const click = await supervisor.act("demo/box", { type: "click", x: 20, y: 16 });
    expect(click.ok).toBe(true);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const published = frames[frames.length - 1]!;
    expect(published.width).toBe(w);
    expect(published.height).toBe(h);
    const tg = decodeJpeg(Buffer.from(published.jpegBase64, "base64"));
    expect(tg.width).toBe(w);
    expect(tg.height).toBe(h);
    const [tr] = pixel(tg, 20, 16);
    expect(tr).toBeGreaterThan(80);
    const again = await supervisor.act("demo/box", { type: "screenshot" });
    expect(again.ok).toBe(true);
    if (again.ok) {
      const clean = decodeJpeg(again.jpeg!);
      const [cr] = pixel(clean, 20, 16);
      expect(cr).toBeLessThan(80);
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("stale_frame recaptures and returns stale_frame", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-comp-stale-"));
    const owner = liveConn();
    const slot: ComputerSlotView = {
      slotKey: "demo/box",
      owner,
      computerAllowed: true,
      turnSource: "operator",
    };
    const frames: string[] = [];
    let pageUrl = "http://a.test/";
    let shotUrl = "";
    const backend: ComputerUseBackend = {
      async screenshot(): Promise<ScreenshotResult> {
        shotUrl = pageUrl;
        return {
          jpeg: FAKE_SCREENSHOT_JPEG,
          width: 1,
          height: 1,
          displayId: "browser",
        };
      },
      async pointer() {
        if (pageUrl !== shotUrl) {
          throw new ComputerBackendError("stale_frame");
        }
      },
      async key() {},
      async typeText() {},
      async navigate() {},
      async probe() {
        return {
          ok: true,
          backend: "fake",
          display: { id: "browser", width: 1, height: 1, scale: 1 },
          missing: [],
          inputEnabled: true,
        };
      },
    };
    const supervisor = createComputerSupervisor({
      backend,
      getConfig: () => ({ enabled: true, minActionIntervalMs: 0 }),
      getSlot: () => slot,
      publishFrame: (f) => {
        frames.push(f.frameId);
      },
      stateDir: dir,
    });
    supervisor.applyGrant("demo/box", owner, {
      enabled: true,
      watch: false,
      expiresAt: 0,
      hostId: "local",
    });
    expect((await supervisor.act("demo/box", { type: "screenshot" })).ok).toBe(
      true,
    );
    pageUrl = "http://b.test/";
    const click = await supervisor.act("demo/box", { type: "click", x: 1, y: 1 });
    expect(click.ok).toBe(false);
    if (!click.ok) expect(click.error).toBe("stale_frame");
    expect(frames.length).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("computer supervisor watch", () => {
  async function setupWatch(opts?: {
    watch?: boolean;
    turnSource?: ComputerSlotView["turnSource"];
    enabled?: boolean;
    coalesceMs?: number;
  }) {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-comp-watch-"));
    const owner = liveConn();
    const slot: ComputerSlotView = {
      slotKey: "demo/box",
      owner,
      computerAllowed: true,
      ...(opts && "turnSource" in opts
        ? { turnSource: opts.turnSource }
        : { turnSource: "operator" }),
    };
    const frames: Array<{ frameId: string; action?: string }> = [];
    const statuses: string[] = [];
    const ticks: Array<() => void> = [];
    const supervisor = createComputerSupervisor({
      backend: createFakeComputerBackend(),
      getConfig: () => ({
        enabled: opts?.enabled ?? true,
        watchIntervalMs: 10,
        frameCoalesceMs: opts?.coalesceMs ?? 0,
        minActionIntervalMs: 0,
      }),
      getSlot: () => slot,
      publishFrame: (f) => {
        frames.push({ frameId: f.frameId, action: f.action });
      },
      publishStatus: (s) => {
        statuses.push(s.text);
      },
      stateDir: dir,
      scheduleWatch: (tick) => {
        ticks.push(tick);
        return () => {
          const i = ticks.indexOf(tick);
          if (i >= 0) ticks.splice(i, 1);
        };
      },
    });
    supervisor.applyGrant("demo/box", owner, {
      enabled: true,
      watch: opts?.watch ?? true,
      expiresAt: 0,
      hostId: "local",
    });
    return { dir, slot, supervisor, frames, statuses, ticks, owner };
  }

  test("watch fires screenshot N times and stops on abort", async () => {
    const { supervisor, frames, ticks, dir } = await setupWatch();
    expect(ticks.length).toBe(1);
    for (let i = 0; i < 3; i++) {
      await ticks[0]!();
      supervisor.ackFrame("demo/box", frames[i]!.frameId);
    }
    expect(frames.length).toBe(3);
    expect(frames.every((f) => f.action === "watch")).toBe(true);
    supervisor.abort("demo/box");
    expect(ticks.length).toBe(0);
    expect(frames.length).toBe(3);
    await rm(dir, { recursive: true, force: true });
  });

  test("watch does not fire when turn is not operator-running", async () => {
    const { frames, ticks, dir } = await setupWatch({ turnSource: "schedule" });
    await ticks[0]!();
    expect(frames).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });

  test("watch does not fire when enabled is off", async () => {
    const { frames, ticks, dir } = await setupWatch({ enabled: false });
    await ticks[0]!();
    expect(frames).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });

  test("watch does not start without grant.watch", async () => {
    const { ticks, dir } = await setupWatch({ watch: false });
    expect(ticks).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });

  test("owner disconnect stops watch", async () => {
    const { supervisor, owner, ticks, frames, dir } = await setupWatch();
    await ticks[0]!();
    expect(frames).toHaveLength(1);
    supervisor.onOwnerDisconnect(owner);
    expect(ticks).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });

  test("missing ACK auto-pauses watch and publishes a status line", async () => {
    const { supervisor, frames, statuses, ticks, dir } = await setupWatch();
    await ticks[0]!();
    expect(frames).toHaveLength(1);
    await ticks[0]!();
    expect(frames).toHaveLength(1);
    expect(supervisor.getGrant("demo/box")?.grant.watch).toBe(true);
    await ticks[0]!();
    expect(frames).toHaveLength(1);
    expect(statuses.some((t) => /Watch paused/i.test(t))).toBe(true);
    expect(supervisor.getGrant("demo/box")?.grant.watch).toBe(false);
    expect(ticks).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });

  test("applyGrant watch=true after pause publishes again", async () => {
    const { supervisor, frames, ticks, owner, dir } = await setupWatch();
    await ticks[0]!();
    await ticks[0]!();
    await ticks[0]!();
    expect(supervisor.getGrant("demo/box")?.grant.watch).toBe(false);
    expect(frames).toHaveLength(1);
    supervisor.applyGrant("demo/box", owner, {
      enabled: true,
      watch: true,
      expiresAt: 0,
      hostId: "local",
    });
    expect(supervisor.getGrant("demo/box")?.grant.watch).toBe(true);
    expect(ticks).toHaveLength(1);
    await ticks[0]!();
    expect(frames).toHaveLength(2);
    expect(supervisor.getGrant("demo/box")?.grant.watch).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("ACK lets watch continue", async () => {
    const { supervisor, frames, ticks, dir } = await setupWatch();
    await ticks[0]!();
    supervisor.ackFrame("demo/box", frames[0]!.frameId);
    await ticks[0]!();
    supervisor.ackFrame("demo/box", frames[1]!.frameId);
    expect(frames).toHaveLength(2);
    expect(supervisor.getGrant("demo/box")?.grant.watch).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("watch does not consume the action budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-comp-watch-bud-"));
    const owner = liveConn();
    const slot: ComputerSlotView = {
      slotKey: "demo/box",
      owner,
      computerAllowed: true,
      turnSource: "operator",
    };
    const ticks: Array<() => void> = [];
    const frames: string[] = [];
    const supervisor = createComputerSupervisor({
      backend: createFakeComputerBackend(),
      getConfig: () => ({
        enabled: true,
        maxActionsPerTurn: 1,
        minActionIntervalMs: 0,
        frameCoalesceMs: 0,
      }),
      getSlot: () => slot,
      publishFrame: (f) => {
        frames.push(f.frameId);
      },
      stateDir: dir,
      scheduleWatch: (tick) => {
        ticks.push(tick);
        return () => {};
      },
    });
    supervisor.applyGrant("demo/box", owner, {
      enabled: true,
      watch: true,
      expiresAt: 0,
      hostId: "local",
    });
    await ticks[0]!();
    supervisor.ackFrame("demo/box", frames[0]!);
    await ticks[0]!();
    expect(frames).toHaveLength(2);
    expect((await supervisor.act("demo/box", { type: "screenshot" })).ok).toBe(
      true,
    );
    expect((await supervisor.act("demo/box", { type: "screenshot" })).error).toBe(
      "budget",
    );
    await rm(dir, { recursive: true, force: true });
  });
});

function pixel(
  img: { width: number; data: Uint8Array },
  x: number,
  y: number,
): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

function inputStubBackend(
  jpeg: Uint8Array,
  width: number,
  height: number,
): ComputerUseBackend {
  return {
    async screenshot(): Promise<ScreenshotResult> {
      return { jpeg, width, height, displayId: "browser" };
    },
    async pointer() {},
    async key() {},
    async typeText() {},
    async navigate() {},
    async probe() {
      return {
        ok: true,
        backend: "fake",
        display: { id: "browser", width, height, scale: 1 },
        missing: [],
        inputEnabled: true,
      };
    },
  };
}
