/**
 * Lightweight JSON Schema subset validation for EVE agent() returns.
 * Enough for type/object/array/required/enum used in directives.
 */
export function validateJsonSchema(
  schema: Record<string, unknown>,
  value: unknown,
): { ok: true } | { ok: false; error: string } {
  try {
    check(schema, value, "$");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function check(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): void {
  const type = schema.type;
  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path}: expected object`);
    }
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required)
      ? (schema.required as string[])
      : [];
    for (const r of required) {
      if (!(r in obj)) throw new Error(`${path}: missing required "${r}"`);
    }
    const props = schema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (props) {
      for (const [k, sub] of Object.entries(props)) {
        if (k in obj) check(sub, obj[k], `${path}.${k}`);
      }
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      value.forEach((v, i) => check(items, v, `${path}[${i}]`));
    }
    return;
  }
  if (type === "string") {
    if (typeof value !== "string") throw new Error(`${path}: expected string`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new Error(`${path}: not in enum`);
    }
    return;
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || (type === "integer" && !Number.isInteger(value))) {
      throw new Error(`${path}: expected ${type}`);
    }
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${path}: expected boolean`);
    return;
  }
  if (type === "null") {
    if (value !== null) throw new Error(`${path}: expected null`);
  }
}

/**
 * Try to parse structured JSON from an agent summary / reply.
 */
export function parseAgentStructuredResult(text: string): unknown {
  const t = text.trim();
  if (!t) return null;

  // fenced json
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }

  // whole string JSON
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      // fall through
    }
  }

  // last JSON object in text
  const lastBrace = t.lastIndexOf("{");
  if (lastBrace >= 0) {
    const slice = t.slice(lastBrace);
    try {
      return JSON.parse(slice);
    } catch {
      // try matching braces
      let depth = 0;
      let end = -1;
      for (let i = lastBrace; i < t.length; i++) {
        if (t[i] === "{") depth++;
        if (t[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end > lastBrace) {
        try {
          return JSON.parse(t.slice(lastBrace, end + 1));
        } catch {
          /* ignore */
        }
      }
    }
  }

  return { summary: t, status: "done" as const };
}

/** Agent leaf finished without hard failure (host may report "completed"). */
export function isEveLeafSuccessStatus(status: string): boolean {
  const s = status.trim().toLowerCase();
  return (
    s === "completed" ||
    s === "idle" ||
    s === "done" ||
    s === "success" ||
    s === "ok"
  );
}

export function isEveLeafFailureStatus(status: string): boolean {
  const s = status.trim().toLowerCase();
  return (
    s === "failed" ||
    s === "killed" ||
    s === "error" ||
    s === "cancelled" ||
    s === "canceled" ||
    s === "timeout"
  );
}

/**
 * Best-effort object when the agent completed but did not return schema JSON.
 * Fills common directive fields (status/summary/issueId) so sequential drains
 * can continue instead of treating successful work as `null` failure.
 */
export function softEveAgentResult(input: {
  label?: string;
  summary: string;
  schemaError?: string;
}): Record<string, unknown> {
  const label = input.label?.trim() || "";
  const issueMatch = label.match(/pas-\d+/i) || label.match(/[A-Z]+-\d+/);
  const issueId = issueMatch
    ? issueMatch[0]!.toUpperCase()
    : label || undefined;
  const summary =
    input.summary.trim() ||
    (input.schemaError
      ? `(completed; unstructured reply — ${input.schemaError})`
      : "(completed; no assistant text / structured JSON)");
  return {
    status: "partial",
    summary: summary.slice(0, 2000),
    ...(issueId ? { issueId } : {}),
  };
}

/**
 * When a completed leaf fails schema validation, try soft fill then re-validate.
 * Returns the accepted value or null if still invalid / hard failure.
 */
export function recoverEveStructuredResult(input: {
  summary: string;
  status: string;
  label?: string;
  schema?: Record<string, unknown>;
  parsed: unknown;
  schemaError?: string;
}): { value: unknown; soft: boolean } | { value: null; soft: false } {
  if (isEveLeafFailureStatus(input.status)) {
    return { value: null, soft: false };
  }
  if (!isEveLeafSuccessStatus(input.status) && input.status !== "timeout") {
    // Unknown status — only soft-recover if we had success-like summary parse.
    if (input.parsed == null && !input.summary.trim()) {
      return { value: null, soft: false };
    }
  }

  let candidate = input.parsed;
  if (candidate == null) {
    candidate = softEveAgentResult({
      label: input.label,
      summary: input.summary,
      schemaError: input.schemaError,
    });
  } else if (
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    candidate !== null
  ) {
    const obj = candidate as Record<string, unknown>;
    const soft = softEveAgentResult({
      label: input.label,
      summary: input.summary,
      schemaError: input.schemaError,
    });
    candidate = {
      ...soft,
      ...obj,
      // Prefer explicit agent fields; fill gaps from soft.
      status: obj.status ?? soft.status,
      summary:
        typeof obj.summary === "string" && obj.summary.trim()
          ? obj.summary
          : soft.summary,
      issueId: obj.issueId ?? soft.issueId,
    };
  }

  if (!input.schema) {
    return { value: candidate, soft: true };
  }
  const v = validateJsonSchema(input.schema, candidate);
  if (v.ok) return { value: candidate, soft: true };

  // Last resort: pure soft object (may still fail strict schemas).
  const softOnly = softEveAgentResult({
    label: input.label,
    summary: input.summary,
    schemaError: input.schemaError ?? v.error,
  });
  const v2 = validateJsonSchema(input.schema, softOnly);
  if (v2.ok) return { value: softOnly, soft: true };
  return { value: null, soft: false };
}
