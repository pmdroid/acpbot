/**
 * Next-run computation for schedule jobs (UTC for MVP).
 *
 * - once: nextRunAt = runAt
 * - cron: 5-field `m h dom mon dow` (minute hour day-of-month month day-of-week)
 *
 * Timezone is stored on the job but next-run always uses **UTC** date parts until a
 * full TZ implementation lands. Prefer timezone "UTC" (or omit).
 *
 * Day-of-month + day-of-week: classic Vixie/crontab semantics — when **both** are
 * restricted (neither is `*`), a day matches if **either** field matches (OR).
 * When either is `*`, the other alone applies (effectively AND with the wildcard).
 */

export type NextRunInput = {
  kind: "once" | "cron";
  runAt?: string;
  cronExpr?: string;
  /** Exclusive lower bound for cron (strictly after this instant). Default: now. */
  from?: Date;
};

function parseIso(iso: string, label: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid ${label}: ${iso}`);
  }
  return d;
}

/** True when the field is unrestricted (literal star only; star-slash-n is not a full wildcard). */
export function isCronFieldWildcard(field: string): boolean {
  const f = field.trim();
  return f === "*";
}

/** Parse a single cron field into a predicate over integer values. */
function fieldMatcher(
  field: string,
  min: number,
  max: number,
  label: string,
): (n: number) => boolean {
  const f = field.trim();
  if (!f) throw new Error(`empty cron ${label}`);

  if (f === "*") return () => true;

  // */step
  const starStep = f.match(/^\*\/(\d+)$/);
  if (starStep) {
    const step = Number(starStep[1]);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron ${label} step: ${f}`);
    }
    return (n) => (n - min) % step === 0;
  }

  // list of values / ranges / steps: a,b-c,d-e/2
  const parts = f.split(",");
  const allowed = new Set<number>();
  for (const part of parts) {
    const p = part.trim();
    const rangeStep = p.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeStep) {
      const a = Number(rangeStep[1]);
      const b = Number(rangeStep[2]);
      const step = rangeStep[3] != null ? Number(rangeStep[3]) : 1;
      if (
        !Number.isInteger(a) ||
        !Number.isInteger(b) ||
        !Number.isInteger(step) ||
        step < 1 ||
        a < min ||
        b > max ||
        a > b
      ) {
        throw new Error(`invalid cron ${label} range: ${p}`);
      }
      for (let v = a; v <= b; v += step) allowed.add(v);
      continue;
    }
    if (!/^\d+$/.test(p)) {
      throw new Error(`invalid cron ${label}: ${p}`);
    }
    const v = Number(p);
    if (v < min || v > max) {
      throw new Error(`cron ${label} out of range: ${v}`);
    }
    allowed.add(v);
  }
  return (n) => allowed.has(n);
}

export type ParsedCron = {
  minute: (n: number) => boolean;
  hour: (n: number) => boolean;
  dom: (n: number) => boolean;
  month: (n: number) => boolean;
  /** 0–6 (Sun–Sat); 7 accepted as Sunday when parsing. */
  dow: (n: number) => boolean;
  /** When both true (both restricted), day matches if dom OR dow. */
  domRestricted: boolean;
  dowRestricted: boolean;
};

/**
 * Parse 5-field cron. Day-of-week: 0 or 7 = Sunday, 1 = Monday, … 6 = Saturday.
 */
export function parseCronExpr(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cronExpr must be 5 fields (m h dom mon dow), got ${fields.length}: ${expr}`,
    );
  }
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];

  const baseDow = fieldMatcher(dow, 0, 7, "dow");
  return {
    minute: fieldMatcher(m, 0, 59, "minute"),
    hour: fieldMatcher(h, 0, 23, "hour"),
    dom: fieldMatcher(dom, 1, 31, "dom"),
    month: fieldMatcher(mon, 1, 12, "month"),
    dow: (n) => {
      // n is 0–6 from Date#getUTCDay
      if (baseDow(n)) return true;
      // allow 7 as Sunday synonym in the expression
      if (n === 0 && baseDow(7)) return true;
      return false;
    },
    domRestricted: !isCronFieldWildcard(dom),
    dowRestricted: !isCronFieldWildcard(dow),
  };
}

/** Day-of-month / day-of-week match with Vixie OR when both restricted. */
export function cronDayMatches(
  parsed: ParsedCron,
  dom: number,
  dow: number,
): boolean {
  if (parsed.domRestricted && parsed.dowRestricted) {
    return parsed.dom(dom) || parsed.dow(dow);
  }
  return parsed.dom(dom) && parsed.dow(dow);
}

/**
 * First UTC minute strictly after `from` that matches the cron.
 * Scans up to ~400 days to avoid infinite loops on impossible expressions.
 */
export function nextCronOccurrence(cronExpr: string, from: Date): Date {
  const parsed = parseCronExpr(cronExpr);
  // Start at the next whole minute after `from`.
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const maxMs = 400 * 24 * 60 * 60 * 1000;
  const end = from.getTime() + maxMs;

  while (cursor.getTime() <= end) {
    const month = cursor.getUTCMonth() + 1;
    const dom = cursor.getUTCDate();
    const dow = cursor.getUTCDay();
    const hour = cursor.getUTCHours();
    const minute = cursor.getUTCMinutes();

    if (
      parsed.month(month) &&
      cronDayMatches(parsed, dom, dow) &&
      parsed.hour(hour) &&
      parsed.minute(minute)
    ) {
      return cursor;
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  throw new Error(
    `no matching cron occurrence within 400 days for: ${cronExpr}`,
  );
}

/** ISO nextRunAt for a create/update. */
export function computeNextRunAt(input: NextRunInput): string {
  if (input.kind === "once") {
    if (!input.runAt?.trim()) {
      throw new Error('kind "once" requires runAt (ISO timestamp)');
    }
    const d = parseIso(input.runAt.trim(), "runAt");
    return d.toISOString();
  }

  if (input.kind === "cron") {
    if (!input.cronExpr?.trim()) {
      throw new Error('kind "cron" requires cronExpr (5-field)');
    }
    const from = input.from ?? new Date();
    return nextCronOccurrence(input.cronExpr.trim(), from).toISOString();
  }

  throw new Error(`unknown schedule kind: ${(input as { kind: string }).kind}`);
}
