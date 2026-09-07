export const DEFAULT_REPLY_GUIDANCE = [
  "You are chatting with the operator over Telegram.",
  "Keep final replies short: a few lines, under ~300 characters, unless the operator explicitly asks for detail.",
  "No headings, no tables, no restating the task.",
  "When you need a decision, call the ask_user_question tool so it renders as tappable buttons — never end a reply with an open question for the operator to type.",
  "Long output belongs in a file — do the work, then reference the path.",
].join(" ");

export const DEFAULT_MAX_REPLY_CHARS = 3500;

export type CappedReply = {
  text: string;
  full: string;
  truncated: boolean;
};

export function capReply(text: string, max: number): CappedReply {
  if (!max || max < 1 || text.length <= max) {
    return { text, full: text, truncated: false };
  }
  let cut = text.lastIndexOf("\n", max - 1);
  if (cut < max * 0.4) cut = text.lastIndexOf(" ", max - 1);
  if (cut < max * 0.4) cut = max - 1;
  return {
    text: `${text.slice(0, cut).trimEnd()}\n…`,
    full: text,
    truncated: true,
  };
}
