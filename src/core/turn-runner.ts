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
import type { SendInTopic, WorkingStatus } from "./working-status";

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

export function createTurnRunner(deps: {
  env: Environment;
  working: WorkingStatus;
  sendInTopic: SendInTopic;
  setSessionStatus: (
    session: PersistedSession,
    status: SessionStatus,
  ) => Promise<void>;
  log: Logger;
}): TurnRunner {
  const { env, working, sendInTopic, setSessionStatus, log } = deps;

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
            }
          }
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
