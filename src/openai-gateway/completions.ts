/**
 * Map OpenAI chat completions → host turns via streamTurn.
 */
import { randomUUID } from "node:crypto";
import type { ChatHost } from "../chat/turn";
import { streamTurn } from "../chat/turn";
import {
  chatCompletionChunk,
  chatCompletionJson,
  latestUserText,
  parseModelId,
  type OpenAiChatCompletionRequest,
} from "./types";

export type CompletionsDeps = {
  host: ChatHost;
  repos: Record<string, string>;
  defaultRepo?: string;
  defaultAgent: string;
  permissionMode: "ask" | "bypass";
};

export async function runCompletion(
  deps: CompletionsDeps,
  body: OpenAiChatCompletionRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const model = String(body.model ?? "").trim();
  if (!model) {
    return jsonError(400, "model is required");
  }
  let sessionKey: string;
  let agent: string;
  try {
    const parsed = parseModelId(model, deps.defaultRepo);
    sessionKey = parsed.sessionKey;
    agent =
      parsed.agent === "default" ? deps.defaultAgent : parsed.agent || deps.defaultAgent;
  } catch (e) {
    return jsonError(400, e instanceof Error ? e.message : String(e));
  }

  const { repo } = splitKey(sessionKey);
  const cwd = deps.repos[repo];
  if (!cwd) {
    return jsonError(
      400,
      `unknown repo "${repo}" in model — configure [repos] or pick another model`,
    );
  }

  const text = latestUserText(body.messages);
  if (!text.trim()) {
    return jsonError(400, "messages must include a user message with text");
  }

  const stream = body.stream !== false; // default stream true for chat UIs
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  if (!stream) {
    let content = "";
    let status = "failed";
    for await (const chunk of streamTurn(deps.host, {
      sessionKey,
      agent,
      cwd,
      text,
      permissionMode: deps.permissionMode,
      signal,
    })) {
      if (chunk.type === "text") content += chunk.text;
      if (chunk.type === "done") status = chunk.status;
      if (chunk.type === "error" && !content) {
        return jsonError(502, chunk.message);
      }
    }
    if (status === "failed" && !content) {
      return jsonError(502, "turn failed");
    }
    return Response.json(chatCompletionJson({ id, model, content }));
  }

  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (s: string) => controller.enqueue(encoder.encode(s));
      try {
        for await (const chunk of streamTurn(deps.host, {
          sessionKey,
          agent,
          cwd,
          text,
          permissionMode: deps.permissionMode,
          signal,
        })) {
          if (signal?.aborted) break;
          if (chunk.type === "text" && chunk.text) {
            write(
              chatCompletionChunk({
                id,
                model,
                content: chunk.text,
              }),
            );
          }
          if (chunk.type === "error") {
            write(
              chatCompletionChunk({
                id,
                model,
                content: `\n[error] ${chunk.message}`,
              }),
            );
          }
          if (chunk.type === "done") {
            write(
              chatCompletionChunk({
                id,
                model,
                finish: "stop",
              }),
            );
          }
        }
        write("data: [DONE]\n\n");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        write(
          chatCompletionChunk({
            id,
            model,
            content: `\n[error] ${msg}`,
            finish: "stop",
          }),
        );
        write("data: [DONE]\n\n");
      } finally {
        controller.close();
      }
    },
    cancel() {
      /* AbortSignal should be wired by caller */
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function splitKey(sessionKey: string): { repo: string; name: string } {
  const i = sessionKey.indexOf("/");
  if (i <= 0) return { repo: sessionKey, name: "main" };
  return {
    repo: sessionKey.slice(0, i),
    name: sessionKey.slice(i + 1),
  };
}

function jsonError(status: number, message: string): Response {
  return Response.json(
    {
      error: {
        message,
        type: "invalid_request_error",
        code: status,
      },
    },
    { status },
  );
}
