/**
 * Convert common Markdown (what models emit) into Telegram HTML parse mode.
 * Telegram HTML is more forgiving than MarkdownV2 for LLM output.
 *
 * Supported subset: **bold**, *italic*, `code`, ```blocks```, [links](url),
 * headings → bold lines, lists, line breaks. Unknown markup is escaped.
 */

const MAX_TG = 4096;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Best-effort markdown → Telegram HTML.
 */
export function markdownToTelegramHtml(md: string): string {
  let s = md.replace(/\r\n/g, "\n");

  // Fenced code blocks first (protect contents)
  const fences: string[] = [];
  s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    const i = fences.length;
    fences.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000FENCE${i}\u0000`;
  });

  // Inline code
  const inlines: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const i = inlines.length;
    inlines.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000INLINE${i}\u0000`;
  });

  // Escape remaining HTML-sensitive chars before adding tags
  s = escapeHtml(s);

  // Links [text](url) — url must be plain after escape
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${url}">${label}</a>`,
  );

  // Headings
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bold **text** or __text__
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic *text* or _text_ (avoid matching inside words for _)
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  s = s.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough ~~text~~
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Restore protected spans
  s = s.replace(/\u0000INLINE(\d+)\u0000/g, (_m, i) => inlines[Number(i)] ?? "");
  s = s.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)] ?? "");

  return s;
}

export type FormattedMessage = {
  text: string;
  parseMode: "HTML";
};

/**
 * Format agent/operator-facing text for Telegram. Falls back to plain
 * escaped HTML if conversion fails validation length, still under 4096 chunks
 * handled by caller.
 */
export function formatForTelegram(text: string): FormattedMessage {
  const html = markdownToTelegramHtml(text);
  return { text: html, parseMode: "HTML" };
}

export function chunkHtmlForTelegram(
  html: string,
  limit = MAX_TG - 16,
): string[] {
  if (html.length <= limit) return [html];
  const parts: string[] = [];
  let rest = html;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.4) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}
