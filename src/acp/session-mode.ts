/**
 * Prefer interactive/default modes so Grok keeps terminal + tools.
 * Only pick pure read-only when explicitly requested via forceReadOnly.
 */
export function pickSessionModeId(
  available: string[],
  opts?: { forceReadOnly?: boolean },
): string | undefined {
  if (available.length === 0) {
    return opts?.forceReadOnly ? "read-only" : undefined;
  }
  if (opts?.forceReadOnly) {
    const preferRo = ["read-only", "read_only", "ask", "plan", "default"];
    for (const id of preferRo) {
      if (available.includes(id)) return id;
    }
    return available[0];
  }
  const prefer = ["default", "ask", "code", "agent", "full", "edit"];
  for (const id of prefer) {
    if (available.includes(id)) return id;
  }
  const nonRo = available.find((id) => !/read.?only|plan/i.test(id));
  return nonRo ?? available[0];
}

/** @deprecated use pickSessionModeId */
export function pickReadOnlyModeId(available: string[]): string | undefined {
  return pickSessionModeId(available, { forceReadOnly: true });
}
