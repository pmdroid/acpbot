/** Minimal OpenAI Chat Completions shapes we accept/emit. */

export type OpenAiChatMessage = {
  role: string;
  content?: string | Array<{ type?: string; text?: string }> | null;
};

export type OpenAiChatCompletionRequest = {
  model: string;
  messages?: OpenAiChatMessage[];
  stream?: boolean;
  user?: string;
};

export type OpenAiModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

/** Parse model id → session binding. */
export type ParsedModelId =
  | { kind: "full"; repo: string; agent: string; sessionName: string }
  | { kind: "agent_only"; agent: string }
  | { kind: "session"; sessionKey: string };

/**
 * Model id forms:
 * - `acpbot/<repo>/<agent>` — ensure `repo/main` with that agent
 * - `acpbot/<repo>/<agent>/<name>` — ensure `repo/name`
 * - `acpbot/session/<repo>/<name>` — sticky existing key
 * - bare `acpbot/<agent>` — uses default_repo from config
 */
export function parseModelId(
  model: string,
  defaultRepo?: string,
): { sessionKey: string; agent: string } {
  const raw = model.trim();
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] !== "acpbot" || parts.length < 2) {
    throw new Error(
      `invalid model "${model}" — use acpbot/<repo>/<agent> or acpbot/<agent>`,
    );
  }
  // acpbot/session/repo/name
  if (parts[1] === "session" && parts.length >= 4) {
    const repo = parts[2]!;
    const name = parts.slice(3).join("/");
    return {
      sessionKey: `${repo}/${name}`,
      agent: "default", // caller should override from ensure default
    };
  }
  if (parts.length === 2) {
    // acpbot/<agent>
    const agent = parts[1]!;
    if (!defaultRepo) {
      throw new Error(
        `model "${model}" needs a repo — use acpbot/<repo>/${agent} or set openai_gateway.default_repo`,
      );
    }
    return { sessionKey: `${defaultRepo}/main`, agent };
  }
  if (parts.length === 3) {
    // acpbot/repo/agent
    return {
      sessionKey: `${parts[1]}/main`,
      agent: parts[2]!,
    };
  }
  // acpbot/repo/agent/name...
  const repo = parts[1]!;
  const agent = parts[2]!;
  const name = parts.slice(3).join("/") || "main";
  return { sessionKey: `${repo}/${name}`, agent };
}

/** Latest user text from OpenAI messages[] (do not replay full history into ACP). */
export function latestUserText(messages: OpenAiChatMessage[] | undefined): string {
  if (!messages?.length) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    return contentToText(m.content);
  }
  return "";
}

export function contentToText(
  content: OpenAiChatMessage["content"],
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

export function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function chatCompletionChunk(opts: {
  id: string;
  model: string;
  content?: string;
  finish?: string | null;
}): string {
  const choice: Record<string, unknown> = {
    index: 0,
    delta: opts.content !== undefined ? { content: opts.content } : {},
    finish_reason: opts.finish ?? null,
  };
  return sseData({
    id: opts.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [choice],
  });
}

export function chatCompletionJson(opts: {
  id: string;
  model: string;
  content: string;
}): Record<string, unknown> {
  return {
    id: opts.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: opts.content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
