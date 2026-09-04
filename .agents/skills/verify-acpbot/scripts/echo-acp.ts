#!/usr/bin/env bun
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

function promptText(params: { prompt?: unknown }): string {
  const prompt = params.prompt;
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  const parts: string[] = [];
  for (const block of prompt) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);

acp
  .agent({ name: "verify-echo" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => ({ sessionId: crypto.randomUUID() }))
  .onRequest("authenticate", () => ({}))
  .onRequest("session/prompt", async (ctx) => {
    const text = promptText(ctx.params);
    await ctx.client.notify("session/update", {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `[echo] ${text}` },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
