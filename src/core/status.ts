import type { AcpTurnEvent, SessionStatus } from "../env/types";

/**
 * Status projection: a pure state machine over ACP events.
 * Status is shown in the in-topic working bubble, not via topic renames.
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
 * Stable topic display name. Set once at createForumTopic; never rewritten for
 * status (work / wait live in the in-topic “⏳/❓” bubble instead).
 */
export function topicName(repo: string, name: string): string {
  return `${repo}/${name}`;
}

/** Bare session identity for createForumTopic. */
export function initialTopicName(repo: string, name: string): string {
  return topicName(repo, name);
}
