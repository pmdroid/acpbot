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
};

export type WorkerToHost =
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
  | { type: "list"; reqId: string };

export type HostToWorker =
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
  | { type: "kill_ok" | "detach_ok" | "cancel_ok"; reqId: string; slotKey: string }
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
  | { type: "err"; reqId: string; error: string };

export function defaultAcpHostSock(
  stateDir = process.env.ACPBOT_STATE_DIR?.trim() || process.env.TACP_STATE_DIR?.trim() || "./data/acpbot-state",
): string {
  const root = stateDir.replace(/\/$/, "");
  return process.env.ACPBOT_ACP_HOST_SOCK || process.env.TACP_ACP_HOST_SOCK?.trim() || `${root}/acp-host.sock`;
}

