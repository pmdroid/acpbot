/**
 * Optional debug progress lines (`digest_interval_sec = 0`).
 * Default EVE Telegram is silent except done / help-needed.
 */

export type EveDigestItem =
  | { kind: "leaf"; label: string; ok: boolean; soft?: boolean }
  | { kind: "log"; message: string }
  | { kind: "phase"; title: string }
  | { kind: "note"; message: string };

const MAX_DIGEST_CHARS = 3500;

export function formatEveDigest(
  name: string,
  items: EveDigestItem[],
): string {
  if (items.length === 0) return "";

  const done = items.filter(
    (i): i is Extract<EveDigestItem, { kind: "leaf" }> =>
      i.kind === "leaf" && i.ok,
  );
  const failed = items.filter(
    (i): i is Extract<EveDigestItem, { kind: "leaf" }> =>
      i.kind === "leaf" && !i.ok,
  );
  const logs = items.filter(
    (i): i is Extract<EveDigestItem, { kind: "log" }> => i.kind === "log",
  );
  const phases = items.filter(
    (i): i is Extract<EveDigestItem, { kind: "phase" }> => i.kind === "phase",
  );
  const notes = items.filter(
    (i): i is Extract<EveDigestItem, { kind: "note" }> => i.kind === "note",
  );

  const head = [`🛰 EVE · ${name}`];
  if (done.length || failed.length) {
    head.push(`${done.length} done`);
    if (failed.length) head.push(`${failed.length} failed`);
    const soft = done.filter((i) => i.soft).length;
    if (soft) head.push(`${soft} partial`);
  } else if (phases.length && !logs.length && !notes.length) {
    const last = phases[phases.length - 1]!;
    head.push(last.title);
  }

  const lines = [head.join(" · ")];

  for (const f of failed.slice(0, 8)) {
    lines.push(`🚫 ${f.label}`);
  }
  if (failed.length > 8) {
    lines.push(`🚫 +${failed.length - 8} more`);
  }

  // Few successes and nothing else to say: names help; many successes stay counted.
  if (done.length > 0 && done.length <= 4 && failed.length === 0) {
    for (const d of done) {
      lines.push(`${d.soft ? "⚠️" : "✅"} ${d.label}`);
    }
  }

  const lastPhases = phases.slice(-2);
  for (const p of lastPhases) {
    lines.push(`phase: ${p.title}`);
  }
  for (const l of logs.slice(-6)) {
    const msg = l.message.trim();
    if (msg) lines.push(msg.slice(0, 200));
  }
  for (const n of notes.slice(-3)) {
    const msg = n.message.trim();
    if (msg) lines.push(msg.slice(0, 200));
  }

  return lines.join("\n").slice(0, MAX_DIGEST_CHARS);
}

/** Debug one-liners when `[eve].digest_interval_sec = 0`. */
export function formatEveProgressLine(item: EveDigestItem): string {
  switch (item.kind) {
    case "leaf":
      return `${item.ok ? (item.soft ? "⚠️" : "✅") : "🚫"} EVE · ${item.label}${
        item.ok ? ` done${item.soft ? " (partial / unstructured)" : ""}` : " failed"
      }`;
    case "log":
      return `🛰 EVE · ${item.message}`;
    case "phase":
      return `🛰 EVE · phase: ${item.title}`;
    case "note":
      return `🛰 EVE · ${item.message}`;
  }
}
