/**
 * ACP session configOptions helpers (model select, etc.).
 */

export type ConfigSelectOption = {
  value: string;
  name?: string;
  description?: string;
};

export type SessionConfigOptionView = {
  id: string;
  name: string;
  type: "select" | "boolean" | string;
  category?: string | null;
  description?: string | null;
  /** Current value id (select) or boolean. */
  currentValue?: string | boolean | null;
  /** Select choices (flattened; groups expanded). */
  options: ConfigSelectOption[];
};

/** Normalize SDK configOptions into a stable view for Telegram pickers. */
export function normalizeConfigOptions(raw: unknown): SessionConfigOptionView[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionConfigOptionView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id) continue;
    const name = typeof o.name === "string" ? o.name : id;
    const type = typeof o.type === "string" ? o.type : "select";
    const category =
      typeof o.category === "string"
        ? o.category
        : o.category === null
          ? null
          : undefined;
    const description =
      typeof o.description === "string"
        ? o.description
        : o.description === null
          ? null
          : undefined;

    let currentValue: string | boolean | null | undefined;
    if ("currentValue" in o) {
      const cv = o.currentValue;
      if (typeof cv === "string" || typeof cv === "boolean") currentValue = cv;
      else if (cv == null) currentValue = null;
    } else if ("value" in o) {
      const v = o.value;
      if (typeof v === "string" || typeof v === "boolean") currentValue = v;
    } else if ("selected" in o && typeof o.selected === "string") {
      currentValue = o.selected;
    }

    const options: ConfigSelectOption[] = [];
    const opts = o.options ?? o.values;
    if (Array.isArray(opts)) {
      for (const opt of opts) {
        if (typeof opt === "string") {
          options.push({ value: opt, name: opt });
          continue;
        }
        if (!opt || typeof opt !== "object") continue;
        const rec = opt as Record<string, unknown>;
        if (Array.isArray(rec.options)) {
          for (const nested of rec.options) {
            if (typeof nested === "string") {
              options.push({ value: nested, name: nested });
            } else if (nested && typeof nested === "object") {
              const n = nested as Record<string, unknown>;
              const value =
                typeof n.value === "string"
                  ? n.value
                  : typeof n.id === "string"
                    ? n.id
                    : "";
              if (!value) continue;
              const entry: ConfigSelectOption = {
                value,
                name: typeof n.name === "string" ? n.name : value,
              };
              if (typeof n.description === "string") {
                entry.description = n.description;
              }
              options.push(entry);
            }
          }
          continue;
        }
        const value =
          typeof rec.value === "string"
            ? rec.value
            : typeof rec.id === "string"
              ? rec.id
              : "";
        if (!value) continue;
        const entry: ConfigSelectOption = {
          value,
          name: typeof rec.name === "string" ? rec.name : value,
        };
        if (typeof rec.description === "string") {
          entry.description = rec.description;
        }
        options.push(entry);
      }
    }

    const view: SessionConfigOptionView = {
      id,
      name,
      type,
      options,
    };
    if (category !== undefined) view.category = category;
    if (description !== undefined) view.description = description;
    if (currentValue !== undefined) view.currentValue = currentValue;
    out.push(view);
  }
  return out;
}

/** Prefer category "model", else id matching /model/i. */
export function findModelConfigOption(
  options: SessionConfigOptionView[],
): SessionConfigOptionView | undefined {
  const byCat = options.find(
    (o) =>
      o.type === "select" &&
      o.category === "model" &&
      o.options.length > 0,
  );
  if (byCat) return byCat;
  return options.find(
    (o) =>
      o.type === "select" &&
      /model/i.test(o.id) &&
      o.options.length > 0,
  );
}

export function currentModelLabel(
  options: SessionConfigOptionView[],
): string | undefined {
  const m = findModelConfigOption(options);
  if (!m) return undefined;
  if (m.currentValue == null) return undefined;
  const v = String(m.currentValue);
  const hit = m.options.find((o) => o.value === v);
  return hit?.name ?? v;
}

export function formatModelStatus(input: {
  configOptions: SessionConfigOptionView[];
}): string {
  const m = findModelConfigOption(input.configOptions);
  if (!m) {
    return (
      "**Model:** _(this agent does not advertise LLM models via ACP)_\n\n" +
      "Use `/agent` to switch the agent process, or configure models in the agent CLI."
    );
  }
  const cur =
    currentModelLabel(input.configOptions) ??
    String(m.currentValue ?? "unknown");
  const lines = [
    `**Model:** \`${cur}\` (config \`${m.id}\`)`,
    "",
    "Available:",
  ];
  for (const o of m.options) {
    const mark = o.value === m.currentValue ? " ← current" : "";
    lines.push(
      `• \`${o.value}\`${o.name && o.name !== o.value ? ` — ${o.name}` : ""}${mark}`,
    );
  }
  lines.push("", "Commands: `/model` (picker) · `/model <value>`");
  return lines.join("\n");
}
