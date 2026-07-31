import type { AcpTurnEvent, SessionStatus } from "../env/types";

/**
 * Status projection: a pure state machine over ACP events.
 * Topic names are derived from status; see topicName().
 */
export function reduceStatus(
  current: SessionStatus,
  event: AcpTurnEvent,
): SessionStatus {
  switch (event.type) {
    case "turn_started":
      return "running";
    case "permission_raised":
      return "waiting-on-you";
    case "permission_settled":
      // After a permission settles, the turn is still in flight.
      return current === "waiting-on-you" ? "running" : current;
    case "turn_ended":
      if (
        event.stopReason === "cancelled" ||
        event.stopReason === "cancel"
      ) {
        return "idle";
      }
      if (event.stopReason === "refusal" || event.stopReason === "max_tokens") {
        return "done";
      }
      return "done";
    case "process_died":
      return "failed";
    case "agent_message_chunk":
    case "tool_call":
    case "tool_call_update":
      // Content events do not change status (and are not projected to chat).
      return current === "idle" ? "running" : current;
    default:
      return current;
  }
}

/**
 * Topic display name. Status is carried in the name so the topic list is the
 * dashboard. Format matches the surface mock: status marker + repo/name.
 */
export function topicName(repo: string, name: string, status: SessionStatus): string {
  const base = `${repo}/${name}`;
  switch (status) {
    case "running":
      return `▶ ${base}`;
    case "waiting-on-you":
      return `❓ ${base}`;
    case "idle":
      return `⏸ ${base}`;
    case "done":
      return `✓ ${base}`;
    case "failed":
      return `✕ ${base}`;
  }
}

/** Bare session identity for createForumTopic (before first status). */
export function initialTopicName(repo: string, name: string): string {
  return topicName(repo, name, "idle");
}
