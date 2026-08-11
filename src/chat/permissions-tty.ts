/**
 * TTY permission prompts for `acpbot chat` (ask y/n/always).
 * Non-TTY defaults to bypass (or reject if forceAsk).
 */
import * as readline from "node:readline";
import type { PermissionDecision, PermissionRequest } from "../env/types";
import { extractPermissionOptions } from "../core/permissions";
import type { SessionHostHooks } from "../acp/session-host";

export type TtyPermissionMode = "ask" | "bypass";

export function createTtyPermissionHooks(opts: {
  mode: TtyPermissionMode;
  /** Override isTTY detection (tests). */
  isTty?: boolean;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}): SessionHostHooks {
  const isTty =
    opts.isTty ??
    (Boolean((opts.stdin as NodeJS.ReadStream | undefined)?.isTTY) ||
      Boolean(process.stdin.isTTY));

  return {
    onPermissionRequest: async (req, ctx) => {
      if (opts.mode === "bypass") {
        return { outcome: "allow_always" };
      }
      if (!isTty) {
        // Unattended CLI: fail closed rather than hang.
        return { outcome: "reject_once" };
      }
      return await promptTtyPermission(req, {
        signal: ctx.signal,
        stdin: opts.stdin ?? process.stdin,
        stdout: opts.stdout ?? process.stdout,
      });
    },
  };
}

async function promptTtyPermission(
  req: PermissionRequest,
  opts: {
    signal: AbortSignal;
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
  },
): Promise<PermissionDecision> {
  const options = extractPermissionOptions(req.raw);
  const title =
    (req.raw as { toolCall?: { title?: string } } | null)?.toolCall?.title ??
    req.toolCallId ??
    "permission";

  const lines = [
    "",
    `❓ Permission: ${title}`,
    ...options.map((o, i) => `  [${i + 1}] ${o.name}`),
    "  [y] allow once   [a] allow always   [n] reject   [c] cancel",
    "> ",
  ];
  opts.stdout.write(lines.join("\n"));

  const answer = await readLine(opts.stdin, opts.signal);
  const a = answer.trim().toLowerCase();
  if (a === "y" || a === "yes" || a === "1") {
    return { outcome: "allow_once" };
  }
  if (a === "a" || a === "always") {
    return { outcome: "allow_always" };
  }
  if (a === "n" || a === "no" || a === "r") {
    return { outcome: "reject_once" };
  }
  if (a === "c" || a === "cancel" || a === "") {
    return { outcome: "cancel" };
  }
  // numeric option
  const n = Number(a);
  if (Number.isFinite(n) && n >= 1 && n <= options.length) {
    const opt = options[n - 1]!;
    const kind = (opt.kind ?? "").toLowerCase().replace(/-/g, "_");
    if (kind.includes("always") && kind.includes("allow")) {
      return { outcome: "allow_always" };
    }
    if (kind.includes("allow")) return { outcome: "allow_once" };
    if (kind.includes("reject")) return { outcome: "reject_once" };
    if (/\bapprove\b|\ballow\b/i.test(opt.name)) {
      return { outcome: "allow_once" };
    }
    return { outcome: "reject_once" };
  }
  return { outcome: "cancel" };
}

function readLine(
  stdin: NodeJS.ReadableStream,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const rl = readline.createInterface({ input: stdin, terminal: false });
    const onAbort = () => {
      rl.close();
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    rl.once("line", (line) => {
      signal.removeEventListener("abort", onAbort);
      rl.close();
      resolve(line);
    });
    rl.once("close", () => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
