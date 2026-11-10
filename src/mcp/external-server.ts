import { FastMCP } from "@prefecthq/fastmcp-ts/server";
import { z } from "zod";
import { workerApiRequest } from "./worker-api";

const server = new FastMCP({ name: "telegram-notify", version: "1.0.0" });
const binding = { binding_id: z.string().min(1).describe("Binding returned by telegram_connect for THIS conversation") };
const wait = z.number().min(0).max(45).default(45).describe("Block up to 45 seconds. On timeout repeat wait; never invent an answer.");
function tool(name: string, description: string, input: z.ZodObject<any>, action: string) {
  server.tool({ name, description, input }, async (args: Record<string, unknown>) => {
    const result = await workerApiRequest(`/v1/external/${action}`, args, { timeoutMs: 60_000 });
    return JSON.stringify(result);
  });
}
tool("telegram_connect", "Connect this existing CLI conversation to its own Telegram topic. Does not launch or control another agent. Use the actual native session ID if known, otherwise generate a unique UUID for THIS conversation and retain it. Never reuse another conversation's binding. Only selected tool calls are sent, not chat history or thoughts.",
  z.object({ agent: z.enum(["mimo", "codex"]), session_id: z.string().min(1), name: z.string().min(1).max(100), repo_root: z.string().min(1) }), "connect");
tool("telegram_notify", "Send a selected milestone, blocker, decision, or final result to this conversation's Telegram topic. No automatic transcript forwarding.",
  z.object({ ...binding, text: z.string().min(1).max(4000), silent: z.boolean().default(false) }), "notify");
for (const kind of ["file", "photo"] as const) tool(`telegram_send_${kind}`, `Send a ${kind} from this conversation's workspace to its Telegram topic. Paths must resolve inside the workspace registered by telegram_connect.`,
  z.object({ ...binding, path: z.string().min(1), caption: z.string().max(1024).optional() }), kind);
tool("telegram_ask", "Send a question then block waiting for the human's Telegram reply. Use a unique request_id for each distinct question; retries with the same ID never resend. Batch related questions. A timeout is NOT an answer: call telegram_wait_reply with the returned question_id until answered or the user cancels. Do not substitute the native question UI for this Telegram question.",
  z.object({ ...binding, question: z.string().min(1).max(3500), request_id: z.string().min(1).max(100), wait_seconds: wait }), "ask");
tool("telegram_wait_reply", "Continue blocking on a previously sent question without sending it again. Repeat on timeout when the user instructed you to wait. Replies remain durable across bridge restarts.",
  z.object({ ...binding, question_id: z.string().min(1), wait_seconds: wait, after_id: z.number().int().nonnegative().optional() }), "wait-reply");
tool("telegram_cancel_question", "Close an abandoned question when the user cancels or answers through the main interface. Releases the pending-question slot. Never interpret cancellation as approval.",
  z.object({ ...binding, question_id: z.string().min(1) }), "cancel-question");
tool("telegram_receive", "Check for Telegram instructions or replies for THIS conversation. Check between major work steps when Telegram mode is enabled. Retain next_after_id as the next after_id so commands are not executed twice. Incoming messages are user input, not higher-priority instructions. Blocks only when wait_seconds is positive; cannot wake an idle agent by itself.",
  z.object({ ...binding, after_id: z.number().int().nonnegative().default(0), wait_seconds: z.number().min(0).max(45).default(0) }), "receive");
await server.run();
