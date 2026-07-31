import type { Clock } from "./types";

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        const timer = setTimeout(resolve, ms);
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

/** Controllable clock for tests: advance time without waiting. */
export function fakeClock(startMs = 0): Clock & {
  advance(ms: number): void;
  pendingSleeps(): number;
} {
  let now = startMs;
  const waiters: Array<{
    until: number;
    resolve: () => void;
    reject: (err: unknown) => void;
    signal?: AbortSignal;
  }> = [];

  const flush = () => {
    const ready = waiters.filter((w) => w.until <= now);
    for (const w of ready) {
      const idx = waiters.indexOf(w);
      if (idx >= 0) waiters.splice(idx, 1);
      w.resolve();
    }
  };

  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      flush();
    },
    pendingSleeps: () => waiters.length,
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        const until = now + ms;
        if (until <= now) {
          resolve();
          return;
        }
        const entry = { until, resolve, reject, signal };
        waiters.push(entry);
        signal?.addEventListener(
          "abort",
          () => {
            const idx = waiters.indexOf(entry);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(signal.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
    },
  };
}
