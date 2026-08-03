/**
 * Drain an ACP turn event stream and deliver the final reply to Telegram.
 * Owns end-of-turn status, TTS, and working-bubble teardown.
 */
import type { Logger } from "../env/logger";
import type {
  AcpTurnEvent,
  Environment,
  SessionStatus,
} from "../env/types";
import { textForTts } from "./media";
import type { PersistedSession } from "./persistence";
import { isSpeakToolName, stripSpeakMarkers, type SpeakRequest } from "./speak";
import { reduceStatus } from "./status";
import {
  formatElapsedWorking,
  formatToolWorkingLabel,
  type SendInTopic,
  type WorkingStatus,
} from "./working-status";

export type TurnRunner = {
  drainTurn(
    session: PersistedSession,
    events: AsyncIterable<AcpTurnEvent>,
  ): Promise<void>;
  maybeSendTts(
    session: PersistedSession,
    replyText: string,
    source: string,
  ): Promise<boolean>;
};

/** How often to refresh the ⏳ bubble with elapsed time during long tool waits. */
const WORKING_HEARTBEAT_MS = 15_000;

export function createTurnRunner(deps: {
  env: Environment;
  working: WorkingStatus;
  sendInTopic: SendInTopic;
  setSessionStatus: (
    session: PersistedSession,
    status: SessionStatus,
  ) => Promise<void>;
  log: Logger;
  /** Inject for tests. */
  now?: () => number;
  heartbeatMs?: number;
}): TurnRunner {
  const { env, working, sendInTopic, setSessionStatus, log } = deps;
  const now = deps.now ?? (() => Date.now());
  const heartbeatMs = deps.heartbeatMs ?? WORKING_HEARTBEAT_MS;

  async function maybeSendTts(
    session: PersistedSession,
    replyText: string,
    source: string,
  ): Promise<boolean> {
    if (!env.speech?.tts || !env.telegram.sendVoice) {
      log.warn("speak requested but TTS unavailable", {
        sessionKey: session.sessionKey,
        source,
      });
      return false;
    }
    const spoken = textForTts(replyText);
    if (!spoken) return false;
    try {
      const audio = await env.speech.tts(spoken);
      await env.telegram.sendVoice({
        chatId: session.chatId,
        messageThreadId: session.messageThreadId,
        data: audio.data,
        filename: audio.filename,
      });
      log.info("tts sent", {
        sessionKey: session.sessionKey,
        source,
        bytes: audio.data.byteLength,
      });
      return true;
    } catch (err) {
      log.warn("tts failed", {
        sessionKey: session.sessionKey,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Drain events without awaiting Telegram inside the consumer loop.
   * Progress: fire-and-forget edits to the ⏳ bubble on tool_call + heartbeat
   * while long tools (e.g. subagent waits) produce no stream events.
   */
  async function drainTurn(
    session: PersistedSession,
    events: AsyncIterable<AcpTurnEvent>,
  ): Promise<void> {
    let status: SessionStatus = session.status;
    const statusTransitions: SessionStatus[] = [];
    const textParts: string[] = [];
    let deathError: string | undefined;
    /** Agent requested voice via MCP speak tool. */
    let speakFromTool: SpeakRequest | undefined;

    const turnStartedAt = now();
    let activityLabel = "Working…";
    let activityStartedAt = turnStartedAt;
    /** Last label we asked the bubble to show (dedupe identical paints). */
    let lastPaintedLabel = "";

    /**
     * Never await — keeps the ACP event queue unblocked (see drain-queue test).
     * working-status serializes edits and skips no-op same-body updates.
     */
    const paintWorking = (label: string, force = false) => {
      const next = label.trim() || "Working…";
      if (!force && next === lastPaintedLabel) return;
      lastPaintedLabel = next;
      void working.set(session, next).catch((err) => {
        log.debug("working progress paint failed", {
          sessionKey: session.sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    const heartbeat = setInterval(() => {
      // Don't clobber permission / ask_user bubbles.
      if (status === "waiting-on-you") return;
      const elapsed = now() - activityStartedAt;
      if (elapsed < heartbeatMs) return;
      // Force so elapsed clock can change while base label stays the same
      paintWorking(formatElapsedWorking(activityLabel, elapsed), true);
    }, heartbeatMs);

    try {
      try {
        for await (const event of events) {
          const next = reduceStatus(status, event);
          if (next !== status) {
            status = next;
            statusTransitions.push(next);
          }
          if (event.type === "agent_message_chunk" && event.text) {
            textParts.push(event.text);
          }
          if (event.type === "tool_call") {
            // Outbound Telegram MCP tools call the worker Unix API directly.
            if (isSpeakToolName(event.title)) {
              // MCP speak already delivered; skip end-of-turn TTS.
              speakFromTool = { source: "tool", text: "" };
              log.info("agent requested speak (worker API)", {
                sessionKey: session.sessionKey,
                title: event.title,
              });
            } else if (status !== "waiting-on-you") {
              const label = formatToolWorkingLabel(
                event.title,
                event.rawInput,
              );
              // Only repaint when the activity description changes
              if (label !== activityLabel) {
                activityLabel = label;
                activityStartedAt = now();
                paintWorking(activityLabel);
              }
            }
          }
          // tool_call_update completed: do NOT flip bubble back to "Working…"
          // (that spam-edited the same line for every micro tool). Leave last
          // tool label until the next distinct tool or turn end.
          if (event.type === "process_died") {
            deathError = event.error ?? "process died";
            if (status !== "failed") {
              status = "failed";
              statusTransitions.push("failed");
            }
          }
        }
      } catch (err) {
        status = "failed";
        statusTransitions.push("failed");
        deathError =
          deathError ?? (err instanceof Error ? err.message : String(err));
      } finally {
        clearInterval(heartbeat);
      }

      // Remove the working bubble before final status / reply so the chat stays clean.
      await working.clear(session);

      try {
        // Skip intermediate waiting-on-you here if permission handler already set it;
        // still apply final statuses from the stream.
        for (const s of statusTransitions) {
          if (s === "waiting-on-you" && session.status === "waiting-on-you") {
            continue;
          }
          await setSessionStatus(session, s);
        }
        if (statusTransitions.length === 0 && session.status !== status) {
          await setSessionStatus(session, status);
        }

        if (deathError) {
          await sendInTopic(
            session,
            `**Agent failed**\n\n\`${deathError}\``,
            undefined,
            { html: true },
          );
          return;
        }

        if (status === "idle" && textParts.length === 0) {
          // cancelled path may already have messaged
          return;
        }

        const rawReply = textParts.join("");
        // Strip any legacy speak markers from text; TTS is MCP speak (or always mode).
        const visibleText = stripSpeakMarkers(rawReply);
        const ttsMode = env.config.ttsMode ?? "agent";
        const speakReq: SpeakRequest | undefined =
          ttsMode === "always"
            ? { source: "always", text: undefined }
            : ttsMode === "off"
              ? undefined
              : speakFromTool;

        if (visibleText.trim()) {
          await sendInTopic(session, visibleText, undefined, { html: true });
        } else if (status === "done" && !speakReq) {
          await sendInTopic(
            session,
            "✓ turn finished (no text output)",
            undefined,
            {
              html: true,
            },
          );
        }

        if (speakReq) {
          // Empty text after mid-turn MCP delivery means already spoken.
          const alreadySpokenViaTool =
            speakReq.source === "tool" && speakReq.text === "";
          if (!alreadySpokenViaTool) {
            const toSpeak =
              speakReq.text?.trim() ||
              visibleText.trim() ||
              rawReply.trim();
            await maybeSendTts(session, toSpeak, speakReq.source);
          }
        }
      } catch (err) {
        try {
          await setSessionStatus(session, "failed");
          await sendInTopic(
            session,
            `✕ turn error: ${err instanceof Error ? err.message : String(err)}`,
          );
        } catch {
          /* ignore */
        }
      }
    } finally {
      await working.clear(session);
    }
  }

  return { drainTurn, maybeSendTts };
}
