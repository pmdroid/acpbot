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

/**
 * Grok Build (and ACP agents using SessionModelState) advertise models as:
 * `{ currentModelId, availableModels: [{ modelId, name, … }] }`
 * on session/new|load and via `_x.ai/models/update` — not as configOptions.
 *
 * See https://github.com/xai-org/grok-build (model_state.rs, set_session_model).
 */
export function modelsStateToConfigOptions(
  models: unknown,
): SessionConfigOptionView[] {
  if (!models || typeof models !== "object") return [];
  const m = models as Record<string, unknown>;
  const currentRaw = m.currentModelId ?? m.current_model_id ?? m.current;
  const currentValue =
    typeof currentRaw === "string"
      ? currentRaw
      : currentRaw &&
          typeof currentRaw === "object" &&
          typeof (currentRaw as { 0?: string }).toString === "function"
        ? String((currentRaw as { 0?: string }).toString?.() ?? "")
        : typeof (currentRaw as { id?: string })?.id === "string"
          ? (currentRaw as { id: string }).id
          : null;

  const available = m.availableModels ?? m.available_models ?? m.available;
  if (!Array.isArray(available) || available.length === 0) return [];

  const options: ConfigSelectOption[] = [];
  for (const item of available) {
    if (typeof item === "string") {
      options.push({ value: item, name: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const value =
      typeof rec.modelId === "string"
        ? rec.modelId
        : typeof rec.model_id === "string"
          ? rec.model_id
          : typeof rec.id === "string"
            ? rec.id
            : typeof rec.value === "string"
              ? rec.value
              : "";
    if (!value) continue;
    const name =
      typeof rec.name === "string"
        ? rec.name
        : typeof rec.label === "string"
          ? rec.label
          : value;
    const opt: ConfigSelectOption = { value, name };
    if (typeof rec.description === "string") opt.description = rec.description;
    options.push(opt);
  }
  if (options.length === 0) return [];

  const view: SessionConfigOptionView = {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    options,
  };
  if (currentValue) view.currentValue = currentValue;
  else if (options[0]) view.currentValue = options[0].value;
  return [view];
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
      !/effort|thought/i.test(o.id) &&
      o.options.length > 0,
  );
}

/**
 * Reasoning effort select (Grok high / medium / low; OpenCode model variants).
 * Prefer id/category "effort" | "thought_level".
 */
export function findEffortConfigOption(
  options: SessionConfigOptionView[],
): SessionConfigOptionView | undefined {
  const byId = options.find(
    (o) =>
      o.type === "select" &&
      o.options.length > 0 &&
      (o.id === "effort" ||
        o.category === "effort" ||
        o.category === "thought_level"),
  );
  if (byId) return byId;
  return options.find(
    (o) =>
      o.type === "select" &&
      o.options.length > 0 &&
      /effort|thought_level/i.test(o.id),
  );
}

/**
 * Session permission/agent mode as a configOption (OpenCode: id/category "mode").
 * Rejects effort-like option sets (high/medium/low) so Grok effort never looks like /mode.
 */
export function findModeConfigOption(
  options: SessionConfigOptionView[],
): SessionConfigOptionView | undefined {
  const candidates = options.filter(
    (o) =>
      o.type === "select" &&
      o.options.length > 0 &&
      (o.id === "mode" ||
        o.category === "mode" ||
        /^session.?mode$/i.test(o.id)),
  );
  for (const c of candidates) {
    if (configOptionLooksLikeEffort(c)) continue;
    return c;
  }
  return undefined;
}

/** True when select values look like reasoning effort, not plan/build/agent. */
export function configOptionLooksLikeEffort(
  opt: SessionConfigOptionView,
): boolean {
  const ids = opt.options.map((o) => o.value.toLowerCase());
  const set = new Set(ids);
  if (set.has("high") || set.has("medium") || set.has("low")) {
    // Pure effort triad (optionally with xhigh/minimal)
    const nonEffort = ids.filter(
      (v) => !/^(high|medium|low|xhigh|minimal|max|default)$/i.test(v),
    );
    if (nonEffort.length === 0) return true;
  }
  if (opt.category === "thought_level" || opt.category === "effort") return true;
  if (/effort|thought/i.test(opt.id + opt.name)) return true;
  return false;
}

/**
 * Grok Build advertises reasoning effort under `_meta["x.ai/sessionConfig"]`
 * with `category: "mode"` and ids high|medium|low — not ACP permission modes.
 *
 * Maps to a synthetic configOption so `/effort` can reuse set_config plumbing
 * (host routes configId "effort" → session/set_mode).
 */
export function sessionConfigEffortToConfigOptions(
  meta: Record<string, unknown> | null | undefined,
): SessionConfigOptionView[] {
  if (!meta || typeof meta !== "object") return [];
  const sc =
    meta["x.ai/sessionConfig"] ??
    meta.sessionConfig ??
    (meta["x.ai"] as { sessionConfig?: unknown } | undefined)?.sessionConfig;
  if (!sc || typeof sc !== "object") return [];
  const rawOptions = (sc as { options?: unknown }).options;
  if (!Array.isArray(rawOptions)) return [];

  const options: ConfigSelectOption[] = [];
  let currentValue: string | undefined;
  for (const item of rawOptions) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    // Grok uses category "mode" for effort; also accept explicit effort names.
    const cat = typeof o.category === "string" ? o.category : "";
    if (
      cat !== "mode" &&
      cat !== "effort" &&
      cat !== "thought_level" &&
      cat !== "reasoning_effort"
    ) {
      continue;
    }
    const id =
      typeof o.id === "string"
        ? o.id
        : typeof o.value === "string"
          ? o.value
          : "";
    if (!id) continue;
    // Skip model-like entries that somehow share an effort-ish category
    if (/^grok/i.test(id)) continue;
    const name =
      typeof o.label === "string"
        ? o.label
        : typeof o.name === "string"
          ? o.name
          : id;
    options.push({ value: id, name });
    if (o.selected === true) currentValue = id;
  }
  if (options.length === 0) return [];
  // Heuristic: classic effort set is high/medium/low (not permission modes).
  const ids = new Set(options.map((o) => o.value.toLowerCase()));
  const looksLikeEffort =
    ids.has("high") ||
    ids.has("medium") ||
    ids.has("low") ||
    ids.has("xhigh") ||
    options.every((o) =>
      /high|medium|low|minimal|max|effort/i.test(o.value + (o.name ?? "")),
    );
  if (!looksLikeEffort) return [];

  const view: SessionConfigOptionView = {
    id: "effort",
    name: "Effort",
    type: "select",
    category: "effort",
    options,
  };
  if (currentValue) view.currentValue = currentValue;
  else if (options[0]) view.currentValue = options[0].value;
  return [view];
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

export function currentEffortLabel(
  options: SessionConfigOptionView[],
): string | undefined {
  const e = findEffortConfigOption(options);
  if (!e) return undefined;
  if (e.currentValue == null) return undefined;
  const v = String(e.currentValue);
  const hit = e.options.find((o) => o.value === v);
  return hit?.name ?? v;
}

export function formatModelStatus(input: {
  configOptions: SessionConfigOptionView[];
}): string {
  const m = findModelConfigOption(input.configOptions);
  if (!m) {
    return "**Model:** _(not advertised)_";
  }
  const cur =
    currentModelLabel(input.configOptions) ??
    String(m.currentValue ?? "unknown");
  const list = m.options
    .map((o) =>
      o.value === m.currentValue
        ? `**\`${o.value}\`**`
        : `\`${o.value}\``,
    )
    .join(" · ");
  return `**Model:** \`${cur}\`\n${list}`;
}

export function formatEffortStatus(input: {
  configOptions: SessionConfigOptionView[];
}): string {
  const e = findEffortConfigOption(input.configOptions);
  if (!e) {
    return "**Effort:** _(not advertised)_";
  }
  const cur = String(e.currentValue ?? "unknown");
  const list = e.options
    .map((o) =>
      o.value === e.currentValue
        ? `**\`${o.value}\`**`
        : `\`${o.value}\``,
    )
    .join(" · ");
  return `**Effort:** \`${cur}\`\n${list}`;
}
