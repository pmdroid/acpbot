import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import {
  createPlaywrightComputerBackend,
  probePlaywrightBrowser,
  slotProfileDir,
} from "../src/computer/playwright";

const probe = probePlaywrightBrowser();

if (!probe.ok) {
  console.warn(
    "chromium/chrome not installed — skipping Playwright computer-use tests",
  );
}

const HTML = `<!doctype html>
<html>
  <head><title>ready</title></head>
  <body style="margin:0;background:#ffffff">
    <button id="b" style="position:absolute;left:40px;top:40px;width:80px;height:40px">go</button>
    <script>
      document.getElementById("b").addEventListener("click", () => {
        document.title = "clicked";
        document.body.style.background = "#00aa00";
      });
    </script>
  </body>
</html>`;

async function withStaticPage<T>(
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}/`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("playwright computer backend", () => {
  test("probe reports playwright and never names the desktop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpbot-pw-probe-"));
    const backend = createPlaywrightComputerBackend({
      stateDir: dir,
      getConfig: () => ({ enabled: true, browserHeadless: true }),
    });
    try {
      const p = await backend.probe();
      expect(p.backend).toBe("playwright");
      expect(p.display.id).toBe("browser");
      if (probe.ok) {
        expect(p.ok).toBe(true);
        expect(p.inputEnabled).toBe(true);
        expect(p.missing).toEqual([]);
      } else {
        expect(p.ok).toBe(false);
        expect(p.missing).toContain("chromium");
        expect(p.inputEnabled).toBe(false);
      }
    } finally {
      await backend.closeAll?.();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!probe.ok)(
    "navigate + screenshot + click against a local page",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acpbot-pw-act-"));
      const backend = createPlaywrightComputerBackend({
        stateDir: dir,
        getConfig: () => ({
          enabled: true,
          browserHeadless: true,
          jpegQuality: 60,
          maxEdgePx: 800,
        }),
      });
      const slotKey = "demo/box";
      try {
        await withStaticPage(async (url) => {
          await backend.navigate({ url, slotKey });
          const shot = await backend.screenshot({ slotKey });
          expect(shot.displayId).toBe("browser");
          expect(shot.jpeg[0]).toBe(0xff);
          expect(shot.jpeg[1]).toBe(0xd8);
          expect(shot.width).toBeGreaterThan(1);
          expect(shot.height).toBeGreaterThan(1);
          expect(shot.frontmost?.title).toBe("ready");

          const profile = slotProfileDir(dir, slotKey);
          expect(existsSync(profile)).toBe(true);
          const st = await stat(profile);
          expect(st.mode & 0o777).toBe(0o700);

          // Button is at (40,40)+(80x40) in the 800-wide viewport.
          await backend.pointer({ kind: "click", x: 80, y: 60 }, slotKey);
          const after = await backend.screenshot({ slotKey });
          expect(after.frontmost?.title).toBe("clicked");
        });

        await expect(
          backend.navigate({ url: "file:///etc/passwd", slotKey }),
        ).rejects.toMatchObject({ code: "invalid_url" });

        await backend.closeSlot?.(slotKey);
        expect(existsSync(slotProfileDir(dir, slotKey))).toBe(false);
      } finally {
        await backend.closeAll?.();
        await rm(dir, { recursive: true, force: true });
      }
    },
    45_000,
  );

  test("source never calls the OS login display", async () => {
    const src = await Bun.file("src/computer/playwright.ts").text();
    expect(src).not.toContain("screencapture");
    expect(src).not.toContain("cliclick");
    expect(src).not.toContain("/dev/fb0");
    expect(src).not.toContain("Screen Recording");
  });
});
