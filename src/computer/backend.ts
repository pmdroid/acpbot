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

/** Host-owned capture / input. Fake backend; input methods throw `input_not_enabled`. */
export type ComputerUseBackend = {
  screenshot(opts: {
    display?: number;
    region?: ScreenshotRegion;
    fullPage?: boolean;
  }): Promise<ScreenshotResult>;
  pointer(action: PointerAction): Promise<void>;
  key(action: KeyAction): Promise<void>;
  typeText(text: string): Promise<void>;
  navigate(opts: { url: string }): Promise<void>;
  probe(): Promise<ComputerProbe>;
};
