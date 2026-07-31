/**
 * tacp MCP server (stdio) — tools the agent can call during a Telegram session.
 *
 * speak: enqueue TTS for the tacp daemon, which sendVoice to Telegram.
 * The MCP process cannot call Telegram itself (it is a child of the agent).
 */
import { FastMCP } from "@prefecthq/fastmcp-ts/server";
import { z } from "zod";
import {
  enqueueSpeakJob,
  speakQueueDir,
  waitForSpeakAck,
} from "./speak-queue";

const server = new FastMCP({
  name: "tacp",
  version: "0.1.0",
});

server.tool(
  {
    name: "speak",
    description:
      "Speak to the user on Telegram: synthesizes TTS and sends a voice note now. " +
      "Use when the user asked for voice/spoken/TTS, or a short audible confirmation " +
      "is clearly better than text alone. Do not call on every message. " +
      "Do not use <<<speak>>> markers — this tool delivers audio directly.",
    input: z.object({
      text: z
        .string()
        .min(1)
        .describe("Text to speak. Keep it short and natural for TTS."),
    }),
  },
  async ({ text }) => {
    const cleaned = text.trim();
    if (!cleaned) {
      return "Nothing to speak (empty text).";
    }
    const sessionKey = process.env.TACP_SESSION_KEY?.trim();
    if (!sessionKey) {
      return (
        "speak failed: TACP_SESSION_KEY not set on MCP server " +
        "(tacp must inject session key via mcpServers env)."
      );
    }
    const queueDir = speakQueueDir();
    try {
      const job = await enqueueSpeakJob({
        sessionKey,
        text: cleaned,
        queueDir,
      });
      const ack = await waitForSpeakAck(job.id, {
        queueDir,
        timeoutMs: 90_000,
      });
      if (!ack.ok) {
        return `speak failed: ${ack.error}`;
      }
      return `Sent Telegram voice note (${cleaned.length} chars${
        ack.bytes != null ? `, ${ack.bytes} bytes` : ""
      }).`;
    } catch (err) {
      return `speak failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
);

await server.run();
