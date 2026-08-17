import type { ComputerProbe } from "../acp-host/protocol";
import {
  ComputerBackendError,
  INPUT_NOT_ENABLED,
  type ComputerUseBackend,
  type ScreenshotResult,
} from "./backend";

/**
 * Tiny 1×1 JPEG (no filesystem). Used as the fixture screenshot so tests
 * never touch screencapture / Playwright.
 */
export const FAKE_SCREENSHOT_JPEG = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAG/AB//2Q==",
    "base64",
  ),
);

export const FAKE_SCREENSHOT_WIDTH = 1;
export const FAKE_SCREENSHOT_HEIGHT = 1;

export function createFakeComputerBackend(): ComputerUseBackend {
  return {
    async screenshot(): Promise<ScreenshotResult> {
      return {
        jpeg: FAKE_SCREENSHOT_JPEG,
        width: FAKE_SCREENSHOT_WIDTH,
        height: FAKE_SCREENSHOT_HEIGHT,
        displayId: "browser",
      };
    },
    async pointer() {
      throw new ComputerBackendError(INPUT_NOT_ENABLED);
    },
    async key() {
      throw new ComputerBackendError(INPUT_NOT_ENABLED);
    },
    async typeText() {
      throw new ComputerBackendError(INPUT_NOT_ENABLED);
    },
    async navigate() {
      throw new ComputerBackendError(INPUT_NOT_ENABLED);
    },
    async probe(): Promise<ComputerProbe> {
      return {
        ok: true,
        backend: "fake",
        display: {
          id: "browser",
          width: FAKE_SCREENSHOT_WIDTH,
          height: FAKE_SCREENSHOT_HEIGHT,
          scale: 1,
        },
        missing: [],
        inputEnabled: false,
      };
    },
  };
}
