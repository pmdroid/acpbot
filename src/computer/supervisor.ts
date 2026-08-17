import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ComputerConfig, Logger } from "../env/types";
import type {
  ComputerFrameEvent,
  ComputerGrantWire,
  ComputerProbe,
} from "../acp-host/protocol";
import {
  ComputerBackendError,
  INPUT_NOT_ENABLED,
  type ComputerUseBackend,
  type ScreenshotRegion,
} from "./backend";
import { annotateCrosshair } from "./annotate";

export type ComputerTurnSource = "operator" | "schedule" | "eve";

export type ComputerOwnerConn = {
  destroyed: boolean;
};

export type ComputerSlotView = {
  slotKey: string;
  owner: ComputerOwnerConn | null;
  computerAllowed?: boolean;
  turnSource?: ComputerTurnSource;
  turnAbort?: { aborted: boolean };
};

export type ComputerDenyReason =
  | "disabled"
  | "no_grant"
  | "expired"
  | "budget"
  | "interval"
  | "abort"
  | "no_owner"
  | "wrong_conn"
  | "not_allowed"
  | "bad_source"
  | "no_ack"
  | "stale_frame"
  | "input_not_enabled"
  | "unauthorized";

export class ComputerDenyError extends Error {
  constructor(readonly reason: ComputerDenyReason) {
    super(reason);
    this.name = "ComputerDenyError";
  }
}

export type ComputerAction =
  | { type: "screenshot"; display?: number; region?: ScreenshotRegion }
  | { type: "status" }
  | { type: "navigate"; url: string }
  | {
      type: "click";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
    }
  | { type: "move"; x: number; y: number }
  | { type: "drag"; x1: number; y1: number; x2: number; y2: number }
  | { type: "scroll"; x: number; y: number; dx?: number; dy?: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string; modifiers?: string[] };

export type ComputerActionOk = {
  ok: true;
  action: string;
  frameId?: string;
  width?: number;
  height?: number;
  jpeg?: Uint8Array;
  status?: ComputerStatusPayload;
};

export type ComputerActionErr = {
  ok: false;
  error: ComputerDenyReason | string;
};

export type ComputerActionResult = ComputerActionOk | ComputerActionErr;

export type ComputerStatusPayload = {
  enabled: boolean;
  grant: ComputerGrantWire | null;
  display: ComputerProbe["display"];
  tcc: string[];
  actionsLeft: number;
  lastFrameId: string | null;
  inputEnabled: boolean;
  backend: ComputerProbe["backend"];
  turnSource?: ComputerTurnSource;
  computerAllowed: boolean;
};

export type ComputerSupervisorOptions = {
  backend: ComputerUseBackend;
  /** Live config — hot-reload mutates this. */
  getConfig: () => ComputerConfig | undefined;
  getSlot: (slotKey: string) => ComputerSlotView | undefined;
  publishFrame: (frame: ComputerFrameEvent) => void;
  log?: Logger;
  stateDir: string;
  now?: () => number;
};

type BoundGrant = {
  grant: ComputerGrantWire;
  conn: ComputerOwnerConn;
  actionsThisTurn: number;
  lastActionAt: number;
  lastFrameId: string | null;
  lastJpeg: Uint8Array | null;
  lastWidth: number;
  lastHeight: number;
  acked: Set<string>;
};

const DEFAULT_MAX_ACTIONS = 40;
const DEFAULT_MIN_INTERVAL_MS = 150;

export function createComputerSupervisor(options: ComputerSupervisorOptions) {
  const log = options.log;
  const now = options.now ?? (() => Date.now());
  const grants = new Map<string, BoundGrant>();

  function computerEnabled(): boolean {
    return options.getConfig()?.enabled === true;
  }

  function maxActions(): number {
    return options.getConfig()?.maxActionsPerTurn ?? DEFAULT_MAX_ACTIONS;
  }

  function minIntervalMs(): number {
    return options.getConfig()?.minActionIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  function dropGrant(slotKey: string): void {
    grants.delete(slotKey);
    void options.backend.closeSlot?.(slotKey);
  }

  function applyGrant(
    slotKey: string,
    conn: ComputerOwnerConn,
    grant: ComputerGrantWire,
  ): void {
    const prev = grants.get(slotKey);
    grants.set(slotKey, {
      grant,
      conn,
      actionsThisTurn: prev && prev.conn === conn ? prev.actionsThisTurn : 0,
      lastActionAt: prev && prev.conn === conn ? prev.lastActionAt : 0,
      lastFrameId: prev && prev.conn === conn ? prev.lastFrameId : null,
      lastJpeg: prev && prev.conn === conn ? prev.lastJpeg : null,
      lastWidth: prev && prev.conn === conn ? prev.lastWidth : 0,
      lastHeight: prev && prev.conn === conn ? prev.lastHeight : 0,
      acked: prev && prev.conn === conn ? prev.acked : new Set(),
    });
    log?.info("computer grant applied", {
      sessionKey: slotKey,
      hostId: grant.hostId,
      watch: grant.watch,
      expiresAt: grant.expiresAt,
    });
  }

  function abort(slotKey: string): void {
    dropGrant(slotKey);
  }

  function abortAll(): void {
    const keys = [...grants.keys()];
    grants.clear();
    for (const key of keys) void options.backend.closeSlot?.(key);
    void options.backend.closeAll?.();
  }

  function onOwnerDisconnect(conn: ComputerOwnerConn): void {
    for (const [slotKey, bound] of [...grants.entries()]) {
      if (bound.conn === conn) {
        dropGrant(slotKey);
        log?.info("computer grant dropped (owner disconnect)", {
          sessionKey: slotKey,
        });
      }
    }
  }

  function ackFrame(slotKey: string, frameId: string): void {
    const bound = grants.get(slotKey);
    if (!bound) return;
    bound.acked.add(frameId);
  }

  function onTurnStart(slotKey: string): void {
    const bound = grants.get(slotKey);
    if (bound) bound.actionsThisTurn = 0;
  }

  function refuse(
    slotKey: string,
    reason: ComputerDenyReason,
  ): ComputerActionErr {
    log?.warn("computer deny", { sessionKey: slotKey, reason });
    return { ok: false, error: reason };
  }

  function gate(slotKey: string): BoundGrant | ComputerActionErr {
    if (!computerEnabled()) return refuse(slotKey, "disabled");

    const bound = grants.get(slotKey);
    if (!bound || !bound.grant.enabled) return refuse(slotKey, "no_grant");
    if (bound.grant.expiresAt > 0 && now() >= bound.grant.expiresAt) {
      dropGrant(slotKey);
      return refuse(slotKey, "expired");
    }

    const slot = options.getSlot(slotKey);
    if (!slot) return refuse(slotKey, "no_owner");
    if (slot.computerAllowed !== true) return refuse(slotKey, "not_allowed");

    const owner = slot.owner;
    if (!owner || owner.destroyed) return refuse(slotKey, "no_owner");
    if (owner !== bound.conn) return refuse(slotKey, "wrong_conn");

    if (slot.turnSource !== "operator") return refuse(slotKey, "bad_source");
    if (slot.turnAbort?.aborted) return refuse(slotKey, "abort");

    if (bound.actionsThisTurn >= maxActions()) {
      return refuse(slotKey, "budget");
    }
    if (
      bound.lastActionAt > 0 &&
      now() - bound.lastActionAt < minIntervalMs()
    ) {
      return refuse(slotKey, "interval");
    }

    return bound;
  }

  async function writeAudit(entry: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(options.stateDir, { recursive: true });
      const path = join(options.stateDir, "computer-audit.jsonl");
      await appendFile(path, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(path, 0o600).catch(() => {});
    } catch {
      /* audit must never break the action */
    }
  }

  function newFrameId(): string {
    return randomBytes(8).toString("hex");
  }

  function jpegQuality(): number {
    return options.getConfig()?.jpegQuality ?? 60;
  }

  function publishShot(
    slotKey: string,
    bound: BoundGrant,
    shot: { jpeg: Uint8Array; width: number; height: number },
    actionName: string,
    annotateAt?: { x: number; y: number },
  ): string {
    const frameId = newFrameId();
    bound.lastFrameId = frameId;
    bound.lastJpeg = shot.jpeg;
    bound.lastWidth = shot.width;
    bound.lastHeight = shot.height;
    const forTelegram =
      annotateAt != null
        ? annotateCrosshair(shot.jpeg, annotateAt.x, annotateAt.y, {
            quality: jpegQuality(),
          })
        : shot.jpeg;
    const caption = `🖥 ${actionName} · ${bound.grant.hostId} · ${bound.actionsThisTurn}/${maxActions()}`;
    options.publishFrame({
      sessionKey: slotKey,
      jpegBase64: Buffer.from(forTelegram).toString("base64"),
      caption,
      width: shot.width,
      height: shot.height,
      action: actionName,
      frameId,
      hostId: bound.grant.hostId,
    });
    log?.info("computer frame published", {
      sessionKey: slotKey,
      frameId,
      bytes: forTelegram.byteLength,
      captionLen: caption.length,
    });
    return frameId;
  }

  async function act(
    slotKey: string,
    action: ComputerAction,
  ): Promise<ComputerActionResult> {
    const t0 = now();
    if (action.type === "status") {
      return status(slotKey);
    }

    const gated = gate(slotKey);
    if ("ok" in gated && gated.ok === false) {
      void writeAudit({
        ts: now(),
        sessionKey: slotKey,
        action: action.type,
        ok: false,
        error: gated.error,
        source: options.getSlot(slotKey)?.turnSource,
      });
      return gated;
    }
    const bound = gated as BoundGrant;
    const slot = options.getSlot(slotKey)!;

    try {
      if (action.type === "screenshot") {
        const shot = await options.backend.screenshot({
          slotKey,
          ...(action.display != null ? { display: action.display } : {}),
          ...(action.region ? { region: action.region } : {}),
        });
        bound.actionsThisTurn += 1;
        bound.lastActionAt = now();
        const frameId = publishShot(slotKey, bound, shot, "screenshot");
        log?.info("computer action", {
          sessionKey: slotKey,
          action: "screenshot",
          frameId,
          ms: now() - t0,
          source: slot.turnSource,
        });
        await writeAudit({
          ts: now(),
          sessionKey: slotKey,
          hostId: bound.grant.hostId,
          action: "screenshot",
          frameId,
          ok: true,
          source: slot.turnSource,
        });
        return {
          ok: true,
          action: "screenshot",
          frameId,
          width: shot.width,
          height: shot.height,
          jpeg: shot.jpeg,
        };
      }

      // Input / navigate — fake throws input_not_enabled; Playwright drives the viewport.
      if (action.type === "navigate") {
        await options.backend.navigate({ url: action.url, slotKey });
      } else if (action.type === "click") {
        await options.backend.pointer(
          {
            kind: "click",
            x: action.x,
            y: action.y,
            ...(action.button ? { button: action.button } : {}),
          },
          slotKey,
        );
      } else if (action.type === "move") {
        await options.backend.pointer(
          { kind: "move", x: action.x, y: action.y },
          slotKey,
        );
      } else if (action.type === "drag") {
        await options.backend.pointer(
          {
            kind: "drag",
            x1: action.x1,
            y1: action.y1,
            x2: action.x2,
            y2: action.y2,
          },
          slotKey,
        );
      } else if (action.type === "scroll") {
        await options.backend.pointer(
          {
            kind: "scroll",
            x: action.x,
            y: action.y,
            ...(action.dx != null ? { dx: action.dx } : {}),
            ...(action.dy != null ? { dy: action.dy } : {}),
          },
          slotKey,
        );
      } else if (action.type === "type") {
        await options.backend.typeText(action.text, slotKey);
      } else if (action.type === "key") {
        await options.backend.key(
          {
            key: action.key,
            ...(action.modifiers ? { modifiers: action.modifiers } : {}),
          },
          slotKey,
        );
      }

      bound.actionsThisTurn += 1;
      bound.lastActionAt = now();

      const clickPoint =
        action.type === "click"
          ? { x: action.x, y: action.y }
          : action.type === "drag"
            ? { x: action.x2, y: action.y2 }
            : undefined;
      let frameId = bound.lastFrameId ?? undefined;
      try {
        const shot = await options.backend.screenshot({ slotKey });
        frameId = publishShot(
          slotKey,
          bound,
          shot,
          action.type,
          clickPoint,
        );
      } catch {
        /* action already applied; frame is best-effort */
      }

      void writeAudit({
        ts: now(),
        sessionKey: slotKey,
        hostId: bound.grant.hostId,
        action: action.type,
        ...(action.type === "click" ||
        action.type === "move" ||
        action.type === "scroll"
          ? { x: action.x, y: action.y }
          : {}),
        ...(action.type === "key" ? { key: action.key } : {}),
        ...(action.type === "type" ? { textLen: action.text.length } : {}),
        frameId,
        ok: true,
        source: slot.turnSource,
      });
      return {
        ok: true,
        action: action.type,
        ...(frameId ? { frameId } : {}),
      };
    } catch (err) {
      const code =
        err instanceof ComputerBackendError
          ? err.code
          : err instanceof ComputerDenyError
            ? err.reason
            : err instanceof Error
              ? err.message
              : String(err);
      const reason = code === INPUT_NOT_ENABLED ? INPUT_NOT_ENABLED : code;
      log?.warn("computer deny", { sessionKey: slotKey, reason });
      if (reason === "stale_frame") {
        try {
          const shot = await options.backend.screenshot({ slotKey });
          bound.actionsThisTurn += 1;
          bound.lastActionAt = now();
          publishShot(slotKey, bound, shot, "screenshot");
        } catch {
          /* recapture is best-effort */
        }
      }
      void writeAudit({
        ts: now(),
        sessionKey: slotKey,
        hostId: bound.grant.hostId,
        action: action.type,
        ok: false,
        error: reason,
        source: slot.turnSource,
      });
      return { ok: false, error: reason };
    }
  }

  async function status(slotKey: string): Promise<ComputerActionResult> {
    const probe = await options.backend.probe();
    const bound = grants.get(slotKey);
    const slot = options.getSlot(slotKey);
    const expired =
      bound != null &&
      bound.grant.expiresAt > 0 &&
      now() >= bound.grant.expiresAt;
    const grant = bound && !expired ? bound.grant : null;
    return {
      ok: true,
      action: "status",
      status: {
        enabled: computerEnabled(),
        grant,
        display: probe.display,
        tcc: probe.missing,
        actionsLeft: Math.max(0, maxActions() - (bound?.actionsThisTurn ?? 0)),
        lastFrameId: bound?.lastFrameId ?? null,
        inputEnabled: probe.inputEnabled,
        backend: probe.backend,
        ...(slot?.turnSource ? { turnSource: slot.turnSource } : {}),
        computerAllowed: slot?.computerAllowed === true,
      },
    };
  }

  async function probe(): Promise<ComputerProbe> {
    return options.backend.probe();
  }

  return {
    applyGrant,
    abort,
    abortAll,
    onOwnerDisconnect,
    ackFrame,
    onTurnStart,
    act,
    status,
    probe,
    /** Test / host-api: live grant bound to this slot, if any. */
    getGrant(slotKey: string): BoundGrant | undefined {
      return grants.get(slotKey);
    },
  };
}

export type ComputerSupervisor = ReturnType<typeof createComputerSupervisor>;
