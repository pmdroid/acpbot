/**
 * NDJSON protocol: acpbot worker ↔ acp-host (Unix socket).
 *
 * Host owns multi-agent ACP stdio processes so the Telegram worker can restart
 * without killing agent context. Agent-agnostic: command/args come from the worker.
 *
 * Slot key = acpbot sessionKey (repo/name), same as durable store.
 */
import type {
  ElicitationDecision,
  PermissionDecision,
} from "../env/types";
import type { HostTurnEvent } from "../acp/session-host";

/** Default per-topic computer grant TTL (30 minutes). 0 on the wire means until /computer off. */
export const COMPUTER_GRANT_TTL_MS = 30 * 60 * 1000;

/**
 * Worker-authoritative per-topic computer grant.
 * `hostId` is worker bookkeeping for routing (D19); the host does not compare it (D21).
 */
export type ComputerGrant = {
  enabled: boolean;
  watch: boolean;
  /** Epoch ms; 0 = until /computer off */
  expiresAt: number;
  /** Host catalog id the grant was issued against (must match resolveHostId). */
  hostId: string;
  grantedAt: number;
};

/** Grant payload on the wire (no grantedAt). */
export type ComputerGrantWire = {
  enabled: boolean;
  watch: boolean;
  expiresAt: number;
  hostId: string;
};

export type ComputerProbe = {
  ok: boolean;
  backend: "macos" | "linux" | "fake" | "playwright";
  display: { id: string; width: number; height: number; scale: number };
  missing: string[];
  inputEnabled: boolean;
};

/** PR 1 stub until a real backend exists. */
export const STUB_COMPUTER_PROBE: ComputerProbe = {
  ok: false,
  backend: "fake",
  missing: ["backend"],
  inputEnabled: false,
  display: { id: "0", width: 0, height: 0, scale: 1 },
};

export type ComputerFrameEvent = {
  sessionKey: string;
  jpegBase64: string;
  caption: string;
  width: number;
  height: number;
  action?: string;
  frameId: string;
  hostId: string;
};

export type HostAgentConfig = {
  /** acpbot agent name, e.g. grok-build */
  agent: string;
  cwd: string;
  /** Optional explicit spawn (else host uses agent-launch builtins) */
  command?: string;
  args?: string[];
  /** Prefer reusing this ACP session id when reattaching */
  resumeSessionId?: string | null;
  mcpEnabled?: boolean;
  /** Tool-permission policy (ask | bypass) */
  permissionMode?: "ask" | "bypass";
  /**
   * Kill any live agent for this slot and spawn fresh (rebuilds MCP servers
   * with current OAuth tokens). Used after `/mcp auth` / token refresh.
   */
  forceRespawn?: boolean;
  /**
   * Drop durable agentSessionId and call session/new (no session/load).
   * Used by topic `/fresh`.
   */
  forceNewSession?: boolean;
};

export type WorkerToHost =
  | {
      /** Authenticate a remote (WSS) connection. Unix sockets skip this. */
      type: "hello";
      reqId: string;
      token: string;
      client?: string;
    }
  | {
      type: "ensure";
      reqId: string;
      slotKey: string;
      config: HostAgentConfig;
    }
  | {
      type: "prompt";
      reqId: string;
      slotKey: string;
      text: string;
      attachments?: Array<{ mediaType: string; data: string }>;
    }
  | { type: "cancel"; reqId: string; slotKey: string }
  | {
      type: "set_mode";
      reqId: string;
      slotKey: string;
      modeId: string;
    }
  | { type: "get_mode"; reqId: string; slotKey: string }
  | { type: "get_config"; reqId: string; slotKey: string }
  | {
      type: "set_config";
      reqId: string;
      slotKey: string;
      configId: string;
      value: string | boolean;
    }
  | { type: "kill"; reqId: string; slotKey: string }
  | { type: "detach"; reqId: string; slotKey: string }
  | {
      type: "permission_result";
      reqId: string;
      slotKey: string;
      permissionReqId: string;
      decision: PermissionDecision | null;
    }
  | {
      type: "elicitation_result";
      reqId: string;
      slotKey: string;
      elicitationReqId: string;
      decision: ElicitationDecision | null;
    }
  | {
      type: "ask_user_question_result";
      reqId: string;
      slotKey: string;
      askReqId: string;
      result: Record<string, unknown>;
    }
  | { type: "ping"; reqId: string }
  | { type: "list"; reqId: string }
  /** EVE: create/start a directive (orchestration runs on host). */
  | {
      type: "eve_run";
      reqId: string;
      sessionKey: string;
      repoKey: string;
      repoRoot: string;
      name?: string;
      path?: string;
      source?: string;
      args?: unknown;
      skipApproval?: boolean;
      agentsMax?: number;
    }
  | {
      type: "eve_approve";
      reqId: string;
      runId: string;
      sessionKey: string;
    }
  | {
      type: "eve_status";
      reqId: string;
      runId: string;
    }
  | {
      type: "eve_list";
      reqId: string;
      sessionKey: string;
      repoRoot: string;
    }
  | {
      type: "eve_pause";
      reqId: string;
      runId: string;
    }
  | {
      type: "eve_resume";
      reqId: string;
      runId: string;
      sessionKey: string;
    }
  | {
      type: "eve_kill";
      reqId: string;
      runId: string;
    }
  | {
      type: "eve_write";
      reqId: string;
      repoRoot: string;
      name: string;
      source: string;
      scope?: "project" | "user";
    }
  | {
      type: "eve_answer";
      reqId: string;
      runId: string;
      sessionKey: string;
      answer: string;
    }
  | {
      type: "computer_grant";
      reqId: string;
      slotKey: string;
      grant: ComputerGrantWire;
    }
  | { type: "computer_abort"; reqId: string; slotKey: string }
  /** Fire-and-forget. No reqId — must not go through client.request() (600s wait). */
  | { type: "computer_frame_ack"; slotKey: string; frameId: string };

export type HostToWorker =
  | { type: "hello_ok"; reqId: string }
  | { type: "hello_err"; reqId: string; error: string }
  | {
      type: "ensure_ok";
      reqId: string;
      slotKey: string;
      agentSessionId: string;
      wasNew: boolean;
      currentModeId?: string;
      availableModeIds: string[];
    }
  | {
      type: "turn_event";
      reqId: string;
      slotKey: string;
      event: HostTurnEvent;
    }
  | {
      type: "prompt_ok";
      reqId: string;
      slotKey: string;
      status: string;
      stopReason?: string;
    }
  | {
      type: "prompt_err";
      reqId: string;
      slotKey: string;
      error: string;
    }
  | {
      type: "permission";
      reqId: string;
      slotKey: string;
      permissionReqId: string;
      sessionId: string;
      toolCallId: string;
      raw: unknown;
    }
  | {
      type: "elicitation";
      reqId: string;
      slotKey: string;
      elicitationReqId: string;
      sessionId: string;
      raw: unknown;
    }
  | {
      type: "ask_user_question";
      reqId: string;
      slotKey: string;
      askReqId: string;
      sessionId: string;
      raw: unknown;
    }
  | {
      type: "set_mode_ok";
      reqId: string;
      slotKey: string;
      currentModeId?: string;
      availableModeIds: string[];
    }
  | {
      type: "get_mode_ok";
      reqId: string;
      slotKey: string;
      currentModeId?: string;
      availableModeIds: string[];
    }
  | {
      type: "get_config_ok";
      reqId: string;
      slotKey: string;
      configOptions: unknown[];
    }
  | {
      type: "set_config_ok";
      reqId: string;
      slotKey: string;
      configOptions: unknown[];
    }
  | {
      type: "kill_ok" | "detach_ok" | "cancel_ok" | "computer_abort_ok";
      reqId: string;
      slotKey: string;
    }
  | { type: "pong"; reqId: string }
  | {
      type: "list_ok";
      reqId: string;
      slots: Array<{
        slotKey: string;
        agentSessionId: string | null;
        agent: string;
        cwd: string;
        busy: boolean;
      }>;
    }
  | { type: "err"; reqId: string; error: string }
  /** EVE command reply (run payload / text). */
  | {
      type: "eve_ok";
      reqId: string;
      message?: string;
      runId?: string;
      run?: unknown;
      text?: string;
      runs?: unknown[];
      scripts?: unknown[];
      path?: string;
      meta?: unknown;
    }
  /**
   * Unsolicited progress for a parent Telegram session.
   * Worker delivers to the topic; host keeps running if worker is down.
   */
  | {
      type: "eve_notify";
      sessionKey: string;
      text: string;
      runId?: string;
      /** When set, worker posts an inline keyboard for /eve answer. */
      ask?: Array<{ id: string; label: string }>;
    }
  | {
      type: "computer_grant_ok";
      reqId: string;
      slotKey: string;
      probe: ComputerProbe;
    }
  | { type: "computer_grant_err"; reqId: string; slotKey: string; error: string }
  | {
      type: "computer_frame";
      sessionKey: string;
      jpegBase64: string;
      caption: string;
      width: number;
      height: number;
      action?: string;
      frameId: string;
      hostId: string;
    }
  | { type: "computer_status"; sessionKey: string; text: string };

export function defaultAcpHostSock(
  stateDir = process.env.ACPBOT_STATE_DIR?.trim() || "./data/acpbot-state",
): string {
  const root = stateDir.replace(/\/$/, "");
  return process.env.ACPBOT_ACP_HOST_SOCK?.trim() || `${root}/acp-host.sock`;
}

