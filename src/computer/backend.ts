import type { ComputerProbe } from "../acp-host/protocol";

export type ScreenshotRegion = { x: number; y: number; w: number; h: number };

export type ScreenshotResult = {
  jpeg: Uint8Array;
  width: number;
  height: number;
  displayId: string;
  frontmost?: {
    title: string;
    bounds: { x: number; y: number; w: number; h: number };
  };
};

export type PointerAction =
  | { kind: "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "move"; x: number; y: number }
  | { kind: "drag"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "scroll"; x: number; y: number; dx?: number; dy?: number };

export type KeyAction = {
  key: string;
  modifiers?: string[];
};

export const INPUT_NOT_ENABLED = "input_not_enabled";

export class ComputerBackendError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ComputerBackendError";
  }
}

/** Host-owned capture / input. Fake throws `input_not_enabled`; Playwright drives an isolated browser. */
export type ComputerUseBackend = {
  screenshot(opts: {
    slotKey?: string;
    display?: number;
    region?: ScreenshotRegion;
    fullPage?: boolean;
  }): Promise<ScreenshotResult>;
  pointer(action: PointerAction, slotKey?: string): Promise<void>;
  key(action: KeyAction, slotKey?: string): Promise<void>;
  typeText(text: string, slotKey?: string): Promise<void>;
  navigate(opts: { url: string; slotKey?: string }): Promise<void>;
  probe(): Promise<ComputerProbe>;
  /** Destroy the isolated profile for this slot (revoke / disconnect / TTL). */
  closeSlot?(slotKey: string): Promise<void>;
  closeAll?(): Promise<void>;
};
