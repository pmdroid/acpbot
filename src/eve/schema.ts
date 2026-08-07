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
