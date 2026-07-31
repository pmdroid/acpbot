/**
 * Telegram callback_data is max 64 **bytes**. Keep payloads tiny and opaque;
 * dereference through in-memory / durable maps.
 */

export const CALLBACK = {
  /** Permission option: p:<token>:<optionIndex> */
  permissionPrefix: "p:",
  /** Elicitation choice: e:<token>:<optionIndex> (-1 = decline) */
  elicitPrefix: "e:",
  /** Grok ask_user_question: q:<token>:<qIdx>:<optIdx> (-1 skip, -2 done) */
  askPrefix: "q:",
  /** New-session repo pick: n:<repoIndex> */
  newRepoPrefix: "n:",
  /** Skill pick: k:<token>:<skillIndex> (-1 = cancel) */
  skillPrefix: "k:",
} as const;

export function encodePermissionCallback(
  token: string,
  optionIndex: number,
): string {
  const data = `${CALLBACK.permissionPrefix}${token}:${optionIndex}`;
  if (byteLength(data) > 64) {
    throw new Error(`callback_data too long (${byteLength(data)} bytes): ${data}`);
  }
  return data;
}

export function parsePermissionCallback(
  data: string,
): { token: string; optionIndex: number } | undefined {
  if (!data.startsWith(CALLBACK.permissionPrefix)) return undefined;
  const rest = data.slice(CALLBACK.permissionPrefix.length);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const token = rest.slice(0, colon);
  const optionIndex = Number(rest.slice(colon + 1));
  if (!token || !Number.isInteger(optionIndex) || optionIndex < 0) {
    return undefined;
  }
  return { token, optionIndex };
}

export function encodeNewRepoCallback(repoIndex: number): string {
  const data = `${CALLBACK.newRepoPrefix}${repoIndex}`;
  if (byteLength(data) > 64) {
    throw new Error(`callback_data too long: ${data}`);
  }
  return data;
}

export function parseNewRepoCallback(data: string): number | undefined {
  if (!data.startsWith(CALLBACK.newRepoPrefix)) return undefined;
  const n = Number(data.slice(CALLBACK.newRepoPrefix.length));
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

export function encodeElicitationCallback(
  token: string,
  optionIndex: number,
): string {
  // optionIndex may be -1 for decline
  const data = `${CALLBACK.elicitPrefix}${token}:${optionIndex}`;
  if (byteLength(data) > 64) {
    throw new Error(`callback_data too long (${byteLength(data)} bytes)`);
  }
  return data;
}

export function parseElicitationCallback(
  data: string,
): { token: string; optionIndex: number } | undefined {
  if (!data.startsWith(CALLBACK.elicitPrefix)) return undefined;
  const rest = data.slice(CALLBACK.elicitPrefix.length);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const token = rest.slice(0, colon);
  const optionIndex = Number(rest.slice(colon + 1));
  if (!token || !Number.isInteger(optionIndex)) return undefined;
  return { token, optionIndex };
}

export function encodeAskQuestionCallback(
  token: string,
  questionIndex: number,
  optionIndex: number,
): string {
  const data = `${CALLBACK.askPrefix}${token}:${questionIndex}:${optionIndex}`;
  if (byteLength(data) > 64) {
    throw new Error(`callback_data too long (${byteLength(data)} bytes)`);
  }
  return data;
}

export function parseAskQuestionCallback(
  data: string,
): { token: string; questionIndex: number; optionIndex: number } | undefined {
  if (!data.startsWith(CALLBACK.askPrefix)) return undefined;
  const rest = data.slice(CALLBACK.askPrefix.length);
  const parts = rest.split(":");
  if (parts.length < 3) return undefined;
  const optionIndex = Number(parts[parts.length - 1]);
  const questionIndex = Number(parts[parts.length - 2]);
  const token = parts.slice(0, -2).join(":");
  if (!token || !Number.isInteger(questionIndex) || !Number.isInteger(optionIndex)) {
    return undefined;
  }
  return { token, questionIndex, optionIndex };
}

export function encodeSkillCallback(token: string, skillIndex: number): string {
  const data = `${CALLBACK.skillPrefix}${token}:${skillIndex}`;
  if (byteLength(data) > 64) {
    throw new Error(`callback_data too long (${byteLength(data)} bytes)`);
  }
  return data;
}

export function parseSkillCallback(
  data: string,
): { token: string; skillIndex: number } | undefined {
  if (!data.startsWith(CALLBACK.skillPrefix)) return undefined;
  const rest = data.slice(CALLBACK.skillPrefix.length);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const token = rest.slice(0, colon);
  const skillIndex = Number(rest.slice(colon + 1));
  if (!token || !Number.isInteger(skillIndex)) return undefined;
  return { token, skillIndex };
}

export function newToken(bytes = 6): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export type InlineButton = { text: string; callback_data: string };

export type InlineKeyboard = {
  inline_keyboard: InlineButton[][];
};

/** Pack buttons into rows of at most 2 (readable on phones). */
export function keyboardFromButtons(buttons: InlineButton[]): InlineKeyboard {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return { inline_keyboard: rows };
}
