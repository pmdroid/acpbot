/**
 * Provisional output volume policy — enough for a working control surface.
 *
 * Full streaming vs digest policy is still a separate effort. Until then:
 * - Buffer agent text during the turn
 * - Deliver once at turn end (chunked under Telegram's 4096 cap)
 * - Never emit tool-call payloads or diffs
 */

export const TELEGRAM_TEXT_LIMIT = 4096;
/** Leave headroom for multi-byte edge cases / future prefixes. */
export const SAFE_CHUNK = 4000;

export function chunkForTelegram(
  text: string,
  limit = SAFE_CHUNK,
): string[] {
  const trimmed = text.replace(/\s+$/u, "");
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const parts: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/u, "");
  }
  if (rest) parts.push(rest);
  return parts;
}
