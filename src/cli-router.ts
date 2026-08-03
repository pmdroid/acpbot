import { basename } from "node:path";

/** True when this process was launched as the old `acpbot-host` name. */
export function isAcpbotHostInvocation(
  argv: string[] = process.argv,
): boolean {
  for (const c of [argv[1], argv[0], process.execPath]) {
    if (!c) continue;
    const base = basename(c).toLowerCase();
    if (base === "acpbot-host" || base.startsWith("acpbot-host-")) return true;
  }
  return false;
}
