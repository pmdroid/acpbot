/**
 * tacp MCP server (stdio) — tools the agent can call during a Telegram session.
 *
 * Spawned by the ACP agent via mcpServers (see buildTacpMcpServers).
 * Currently: speak (TTS request). STT and more tools can land here later.
 *
 * Delivery path: tool call is observed by tacp's ACP event stream; the daemon
 * synthesizes voice and sendVoice. This process only validates + acknowledges.
 */
import { FastMCP } from "@prefecthq/fastmcp-ts/server";
import { z } from "zod";

const server = new FastMCP({
  name: "tacp",
  version: "0.1.0",
});

server.tool(
  {
    name: "speak",
    description:
      "Send a Telegram voice note to the user (tacp TTS). " +
      "Use only when the user asked for voice/spoken reply, or a short " +
      "audible confirmation is clearly better than text alone. " +
      "Do not call on every message. Prefer a concise spoken line.",
    input: z.object({
      text: z
        .string()
        .min(1)
        .describe("Text to speak. Keep it short and natural for TTS."),
    }),
  },
  ({ text }) => {
    const cleaned = text.trim();
    if (!cleaned) {
      return "Nothing to speak (empty text).";
    }
    // Daemon detects this MCP tool call via ACP session updates and runs TTS.
    return `Voice note queued for the user (${cleaned.length} chars).`;
  },
);

// STT / other host tools will register here later.

await server.run();
