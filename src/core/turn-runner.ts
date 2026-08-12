/**
 * Drain an ACP turn event stream and deliver agent text to Telegram.
 * Progressive paragraph flushes mid-turn (fire-and-forget); remainder + TTS
 * + working-bubble teardown at turn end.
 */
import { readFile } from "node:fs/promises";
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

/**
 * Mid-turn agent text is flushed when we hit a paragraph break (or grow large),
 * so long turns show progress in Telegram without waiting for turn end.
 * Never await these flushes inside the ACP event loop.
 */
const MID_TURN_MIN_CHARS = 40;
const MID_TURN_FORCE_CHARS = 1200;

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
   * Progress: fire-and-forget ⏳ bubble paints + progressive text flushes.
   * Final remainder / TTS run after the stream is exhausted.
   */
  async function drainTurn(
    session: PersistedSession,
    events: AsyncIterable<AcpTurnEvent>,
  ): Promise<void> {
    let status: SessionStatus = session.status;
    const statusTransitions: SessionStatus[] = [];
    const textParts: string[] = [];
    /** How many chars of `textParts.join("")` already sent mid-turn. */
    let flushedLen = 0;
    let midTurnMessages = 0;
    /** Serialize mid-turn text posts; never awaited inside the event loop. */
    let flushChain: Promise<void> = Promise.resolve();
    let deathError: string | undefined;
    /** Agent requested voice via MCP speak tool. */
    let speakFromTool: SpeakRequest | undefined;
    /** Grok plan-mode exit — may cancel without client permission UI. */
    let sawExitPlanMode = false;
    let planMdPath: string | undefined;
    let turnStopReason: string | undefined;

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

    /**
     * Post complete-ish agent text during the turn so the operator is not
     * stuck staring at ⏳ until tools finish. Fire-and-forget only.
     */
    const enqueueTextFlush = (force: boolean) => {
      flushChain = flushChain
        .then(async () => {
          const full = textParts.join("");
          const unsent = full.slice(flushedLen);
          if (!unsent) return;

          let cut = unsent.length;
          if (!force) {
            const para = unsent.lastIndexOf("\n\n");
            if (para >= MID_TURN_MIN_CHARS) {
              cut = para + 2;
            } else if (unsent.length >= MID_TURN_FORCE_CHARS) {
              const nl = unsent.lastIndexOf("\n", MID_TURN_FORCE_CHARS);
              cut =
                nl >= MID_TURN_MIN_CHARS ? nl + 1 : MID_TURN_FORCE_CHARS;
            } else {
              return; // wait for more text / tool boundary / turn end
            }
          }

          const piece = unsent.slice(0, cut);
          flushedLen += piece.length;
          const visible = stripSpeakMarkers(piece).trim();
          if (!visible) return;

          await sendInTopic(session, visible, undefined, { html: true });
          midTurnMessages += 1;
          log.debug("mid-turn agent text flushed", {
            sessionKey: session.sessionKey,
            chars: visible.length,
            force,
          });
        })
        .catch((err) => {
          log.debug("mid-turn text flush failed", {
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
            enqueueTextFlush(false);
          }
          if (event.type === "tool_call") {
            // Push any pending narrative before tool activity so it is not
            // stuck behind a long subagent / command wait.
            enqueueTextFlush(true);
            const title = String(event.title ?? "");
            if (isExitPlanModeTitle(title)) {
              sawExitPlanMode = true;
            }
            const planPath = extractPlanMdPath(event);
            if (planPath) planMdPath = planPath;
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
          if (event.type === "turn_ended") {
            turnStopReason = event.stopReason;
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

      // Finish any mid-turn posts, then drop the ⏳ bubble before final remainder.
      await flushChain;
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

        // Plan exit often ends as cancelled when the agent auto-approves
        // exit_plan_mode (GROK_PERMISSION_MODE / --always-approve). Deliver
        // plan.md so the operator still gets the plan + how to proceed.
        const cancelled =
          turnStopReason === "cancelled" ||
          turnStopReason === "cancel" ||
          status === "idle";
        if (sawExitPlanMode && cancelled) {
          log.info("plan-exit fallback: deliver plan after cancelled turn", {
            sessionKey: session.sessionKey,
            planMdPath: planMdPath ?? null,
            stopReason: turnStopReason ?? null,
          });
          await deliverPlanExitFallback(session, planMdPath, sendInTopic, log);
          // Only unsent assistant text (mid-turn may already have flushed some)
          const pre = stripSpeakMarkers(
            textParts.join("").slice(flushedLen),
          ).trim();
          if (pre) {
            await sendInTopic(session, pre, undefined, { html: true });
          }
          return;
        }

        if (status === "idle" && textParts.length === 0) {
          // cancelled path may already have messaged
          return;
        }

        const rawReply = textParts.join("");
        // Strip any legacy speak markers from text; TTS is MCP speak (or always mode).
        const visibleText = stripSpeakMarkers(rawReply);
        const remaining = stripSpeakMarkers(rawReply.slice(flushedLen)).trim();
        const ttsMode = env.config.ttsMode ?? "agent";
        const speakReq: SpeakRequest | undefined =
          ttsMode === "always"
            ? { source: "always", text: undefined }
            : ttsMode === "off"
              ? undefined
              : speakFromTool;

        if (remaining) {
          await sendInTopic(session, remaining, undefined, { html: true });
        } else if (
          status === "done" &&
          !speakReq &&
          midTurnMessages === 0 &&
          !visibleText.trim()
        ) {
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

function isExitPlanModeTitle(title: string): boolean {
  const t = title.toLowerCase();
  return (
    t.includes("exit_plan") ||
    t.includes("exit plan") ||
    t.includes("plan: exit") ||
    t === "plan exit"
  );
}

function extractPlanMdPath(event: {
  title?: string | undefined;
  rawInput?: unknown;
}): string | undefined {
  const tryPath = (s: string | undefined): string | undefined => {
    if (!s) return undefined;
    if (/plan\.md$/i.test(s) || s.includes("/plan.md")) return s;
    return undefined;
  };
  const title = event.title ? String(event.title) : "";
  // Write `/path/to/plan.md`
  const m = title.match(/`([^`]+\.md)`/);
  if (m?.[1] && tryPath(m[1])) return m[1];
  if (tryPath(title)) return title;

  const ri = event.rawInput;
  if (ri && typeof ri === "object") {
    const o = ri as Record<string, unknown>;
    for (const k of ["file_path", "path", "target_file", "filePath"]) {
      if (typeof o[k] === "string" && tryPath(o[k] as string)) {
        return o[k] as string;
      }
    }
  }
  return undefined;
}

async function deliverPlanExitFallback(
  session: PersistedSession,
  planMdPath: string | undefined,
  sendInTopic: SendInTopic,
  log: Logger,
): Promise<void> {
  let body = "";
  if (planMdPath) {
    try {
      body = await readFile(planMdPath, "utf8");
    } catch (err) {
      log.warn("plan-exit fallback: could not read plan.md", {
        sessionKey: session.sessionKey,
        planMdPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const header =
    `📋 <b>Plan ready</b>\n` +
    `<i>Plan mode finished — approve with <code>/build</code> to implement, ` +
    `or stay in plan with <code>/plan</code> / keep chatting.</i>\n`;

  // These bodies are already Telegram HTML — use alreadyHtml so formatForTelegram
  // does not escape <b>/<code>/… into visible &lt;b&gt; junk.
  const html = { alreadyHtml: true as const };

  if (!body.trim()) {
    await sendInTopic(
      session,
      header +
        `\n<code>plan.md</code> not found on disk. Ask the agent to reprint the plan, then <code>/build</code>.`,
      undefined,
      html,
    );
    return;
  }

  // Telegram message limit ~4096; leave room for header.
  const maxBody = 3500;
  const chunks: string[] = [];
  let rest = body.trim();
  while (rest.length > 0) {
    if (rest.length <= maxBody) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", maxBody);
    if (cut < maxBody / 2) cut = maxBody;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }

  await sendInTopic(session, header, undefined, html);
  for (let i = 0; i < chunks.length; i++) {
    const part = chunks[i]!;
    const prefix =
      chunks.length > 1 ? `<b>Plan (${i + 1}/${chunks.length})</b>\n` : "";
    // Escape minimal HTML in plan body by wrapping as pre
    const safe = part
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    await sendInTopic(
      session,
      `${prefix}<pre>${safe.slice(0, 3800)}</pre>`,
      undefined,
      html,
    );
  }
  await sendInTopic(
    session,
    `Next: <code>/build</code> to leave plan mode and implement, or keep refining in plan.`,
    undefined,
    html,
  );
}
