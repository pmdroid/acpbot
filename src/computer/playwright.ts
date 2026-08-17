/**
 * Isolated Playwright browser backend.
 *
 * One persistent context per granted slot under $state_dir/computer-browser/.
 * Never launches against the operator's real Chrome profile, and never
 * screenshots the OS login display.
 */
import { chmod, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { ComputerProbe } from "../acp-host/protocol";
import type { ComputerConfig, Logger } from "../env/types";
import {
  ComputerBackendError,
  type ComputerUseBackend,
  type KeyAction,
  type PointerAction,
  type ScreenshotResult,
} from "./backend";
import { downsampleToMaxEdge } from "./annotate";

export const MISSING_CHROMIUM = "chromium";
export const MISSING_BROWSER_MESSAGE =
  "Playwright browser missing (chromium). Install Google Chrome or run: npx playwright install chromium";

const DEFAULT_MAX_EDGE = 1280;
const DEFAULT_JPEG_QUALITY = 60;
const DEFAULT_VIEWPORT_H = 800;

export type BrowserLaunchSpec = {
  channel?: string;
  executablePath?: string;
  label: string;
};

export type PlaywrightBrowserProbe = {
  ok: boolean;
  missing: string[];
  label?: string;
};

/** Cheap existence check — do not launch a browser. */
export function probePlaywrightBrowser(
  preferred?: string,
): PlaywrightBrowserProbe {
  const spec = resolveBrowserLaunch(preferred);
  if (!spec) return { ok: false, missing: [MISSING_CHROMIUM] };
  return { ok: true, missing: [], label: spec.label };
}

export function resolveBrowserLaunch(
  preferred?: string,
): BrowserLaunchSpec | null {
  const order: string[] = [];
  const pref = preferred?.trim();
  if (pref) order.push(pref);
  for (const name of ["chrome", "chromium", "msedge"] as const) {
    if (!order.includes(name)) order.push(name);
  }
  for (const name of order) {
    const spec = specForChannel(name);
    if (spec) return spec;
  }
  return null;
}

export function computerBrowserRoot(stateDir: string): string {
  return join(stateDir.replace(/\/$/, ""), "computer-browser");
}

export function safeSlotDirName(slotKey: string): string {
  const s = slotKey.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 180);
  return s || "slot";
}

export function slotProfileDir(stateDir: string, slotKey: string): string {
  return join(computerBrowserRoot(stateDir), safeSlotDirName(slotKey));
}

function specForChannel(name: string): BrowserLaunchSpec | null {
  if (name === "chromium") {
    const bundled = playwrightChromiumPath();
    if (bundled) return { executablePath: bundled, label: "chromium" };
    const sys = firstExisting(systemChromiumPaths());
    if (sys) return { executablePath: sys, label: "chromium" };
    return null;
  }
  if (name === "chrome") {
    if (firstExisting(systemChromePaths())) {
      return { channel: "chrome", label: "chrome" };
    }
    return null;
  }
  if (name === "msedge") {
    if (firstExisting(systemEdgePaths())) {
      return { channel: "msedge", label: "msedge" };
    }
    return null;
  }
  // Unknown channel — only accept it if a matching binary is on disk.
  return null;
}

function playwrightChromiumPath(): string | undefined {
  try {
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

function systemChromePaths(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
  }
  if (process.platform === "linux") {
    return whichAll([
      "google-chrome",
      "google-chrome-stable",
      "google-chrome-beta",
    ]);
  }
  return [];
}

function systemChromiumPaths(): string[] {
  if (process.platform === "darwin") {
    return ["/Applications/Chromium.app/Contents/MacOS/Chromium"];
  }
  if (process.platform === "linux") {
    return whichAll(["chromium", "chromium-browser"]);
  }
  return [];
}

function systemEdgePaths(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (process.platform === "linux") {
    return whichAll(["microsoft-edge", "microsoft-edge-stable"]);
  }
  return [];
}

function firstExisting(paths: string[]): string | undefined {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

function whichAll(cmds: string[]): string[] {
  const out: string[] = [];
  for (const cmd of cmds) {
    try {
      const found = execFileSync("which", [cmd], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (found) out.push(found);
    } catch {
      /* not on PATH */
    }
  }
  return out;
}

type LastShot = {
  url: string;
  vpW: number;
  vpH: number;
  jpegW: number;
  jpegH: number;
};

type SlotSession = {
  context: BrowserContext;
  page: Page;
  lastShot: LastShot | null;
  profileDir: string;
};

export type PlaywrightBackendOptions = {
  stateDir: string;
  getConfig: () => ComputerConfig | undefined;
  log?: Logger;
};

export function createPlaywrightComputerBackend(
  options: PlaywrightBackendOptions,
): ComputerUseBackend {
  const sessions = new Map<string, SlotSession>();
  const log = options.log;

  function cfg(): ComputerConfig {
    return options.getConfig() ?? {};
  }

  function maxEdge(): number {
    return cfg().maxEdgePx ?? DEFAULT_MAX_EDGE;
  }

  function jpegQuality(): number {
    return cfg().jpegQuality ?? DEFAULT_JPEG_QUALITY;
  }

  function viewport(): { width: number; height: number } {
    const w = maxEdge();
    const h = w === DEFAULT_MAX_EDGE ? DEFAULT_VIEWPORT_H : Math.round(w * 0.625);
    return { width: w, height: Math.max(1, h) };
  }

  function missingError(): ComputerBackendError {
    return new ComputerBackendError("missing_chromium", MISSING_BROWSER_MESSAGE);
  }

  function launchSpec(): BrowserLaunchSpec {
    const spec = resolveBrowserLaunch(cfg().browserChannel);
    if (!spec) throw missingError();
    return spec;
  }

  async function ensureProfileRoot(): Promise<string> {
    const root = computerBrowserRoot(options.stateDir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700).catch(() => {});
    return root;
  }

  async function session(slotKey: string): Promise<SlotSession> {
    const existing = sessions.get(slotKey);
    if (existing) return existing;

    const spec = launchSpec();
    await ensureProfileRoot();
    const dir = slotProfileDir(options.stateDir, slotKey);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});

    const vp = viewport();
    const launch: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: cfg().browserHeadless !== false,
      viewport: vp,
      deviceScaleFactor: 1,
      acceptDownloads: false,
      args: ["--no-first-run", "--no-default-browser-check"],
    };
    if (spec.channel) launch.channel = spec.channel;
    if (spec.executablePath) launch.executablePath = spec.executablePath;

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(dir, launch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn("playwright launch failed", { error: msg, label: spec.label });
      throw new ComputerBackendError(
        "missing_chromium",
        `${MISSING_BROWSER_MESSAGE} (${msg})`,
      );
    }

    const page = context.pages()[0] ?? (await context.newPage());
    const s: SlotSession = { context, page, lastShot: null, profileDir: dir };
    sessions.set(slotKey, s);
    return s;
  }

  function requireSlot(slotKey: string | undefined): string {
    const key = slotKey?.trim();
    if (!key) {
      throw new ComputerBackendError("no_slot", "slotKey required");
    }
    return key;
  }

  function mapPoint(s: SlotSession, x: number, y: number): { x: number; y: number } {
    const shot = s.lastShot;
    if (!shot || shot.jpegW < 1 || shot.jpegH < 1) {
      return { x, y };
    }
    return {
      x: (x * shot.vpW) / shot.jpegW,
      y: (y * shot.vpH) / shot.jpegH,
    };
  }

  function assertPointerFresh(s: SlotSession): void {
    if (!s.lastShot) {
      throw new ComputerBackendError(
        "no_frame",
        "call computer_screenshot first",
      );
    }
    const url = s.page.url();
    const vp = s.page.viewportSize();
    if (
      url !== s.lastShot.url ||
      !vp ||
      vp.width !== s.lastShot.vpW ||
      vp.height !== s.lastShot.vpH
    ) {
      throw new ComputerBackendError(
        "stale_frame",
        "navigation or viewport changed since frameId",
      );
    }
  }

  async function capture(s: SlotSession, region?: {
    x: number;
    y: number;
    w: number;
    h: number;
  }): Promise<ScreenshotResult> {
    const quality = Math.max(1, Math.min(100, jpegQuality()));
    const clip =
      region && region.w > 0 && region.h > 0
        ? {
            x: Math.max(0, region.x),
            y: Math.max(0, region.y),
            width: region.w,
            height: region.h,
          }
        : undefined;
    const raw = await s.page.screenshot({
      type: "jpeg",
      quality,
      fullPage: false,
      ...(clip ? { clip } : {}),
    });
    const down = downsampleToMaxEdge(raw, maxEdge(), quality);
    const vp = s.page.viewportSize() ?? viewport();
    s.lastShot = {
      url: s.page.url(),
      vpW: vp.width,
      vpH: vp.height,
      jpegW: down.width,
      jpegH: down.height,
    };
    let title = "";
    try {
      title = await s.page.title();
    } catch {
      title = "";
    }
    return {
      jpeg: down.jpeg,
      width: down.width,
      height: down.height,
      displayId: "browser",
      frontmost: {
        title,
        bounds: { x: 0, y: 0, w: down.width, h: down.height },
      },
    };
  }

  async function closeSlot(slotKey: string): Promise<void> {
    const s = sessions.get(slotKey);
    sessions.delete(slotKey);
    if (s) {
      try {
        await s.context.close();
      } catch {
        /* already gone */
      }
    }
    const dir = s?.profileDir ?? slotProfileDir(options.stateDir, slotKey);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  async function closeAll(): Promise<void> {
    const keys = [...sessions.keys()];
    await Promise.all(keys.map((k) => closeSlot(k)));
  }

  const backend: ComputerUseBackend = {
    async screenshot(opts) {
      const slotKey = requireSlot(opts.slotKey);
      const s = await session(slotKey);
      return capture(s, opts.region);
    },

    async pointer(action: PointerAction, slotKey?: string) {
      const s = await session(requireSlot(slotKey));
      assertPointerFresh(s);
      if (action.kind === "click") {
        const p = mapPoint(s, action.x, action.y);
        await s.page.mouse.click(p.x, p.y, {
          button: action.button ?? "left",
        });
        return;
      }
      if (action.kind === "move") {
        const p = mapPoint(s, action.x, action.y);
        await s.page.mouse.move(p.x, p.y);
        return;
      }
      if (action.kind === "drag") {
        const a = mapPoint(s, action.x1, action.y1);
        const b = mapPoint(s, action.x2, action.y2);
        await s.page.mouse.move(a.x, a.y);
        await s.page.mouse.down();
        await s.page.mouse.move(b.x, b.y, { steps: 8 });
        await s.page.mouse.up();
        return;
      }
      const p = mapPoint(s, action.x, action.y);
      await s.page.mouse.move(p.x, p.y);
      await s.page.mouse.wheel(action.dx ?? 0, action.dy ?? 0);
    },

    async key(action: KeyAction, slotKey?: string) {
      const s = await session(requireSlot(slotKey));
      const parts = [...(action.modifiers ?? []), action.key].filter(Boolean);
      if (parts.length === 0) {
        throw new ComputerBackendError("invalid_key", "key required");
      }
      await s.page.keyboard.press(parts.join("+"));
    },

    async typeText(text: string, slotKey?: string) {
      const s = await session(requireSlot(slotKey));
      await s.page.keyboard.type(text);
    },

    async navigate(opts) {
      const slotKey = requireSlot(opts.slotKey);
      let parsed: URL;
      try {
        parsed = new URL(opts.url);
      } catch {
        throw new ComputerBackendError("invalid_url", "invalid URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ComputerBackendError("invalid_url", "http/https only");
      }
      const s = await session(slotKey);
      await s.page.goto(parsed.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      s.lastShot = null;
    },

    async probe(): Promise<ComputerProbe> {
      const found = probePlaywrightBrowser(cfg().browserChannel);
      const vp = viewport();
      if (!found.ok) {
        return {
          ok: false,
          backend: "playwright",
          display: { id: "browser", width: 0, height: 0, scale: 1 },
          missing: [MISSING_CHROMIUM],
          inputEnabled: false,
        };
      }
      return {
        ok: true,
        backend: "playwright",
        display: {
          id: "browser",
          width: vp.width,
          height: vp.height,
          scale: 1,
        },
        missing: [],
        inputEnabled: true,
      };
    },

    closeSlot,
    closeAll,
  };

  return backend;
}
