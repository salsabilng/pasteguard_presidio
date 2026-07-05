/**
 * Placeholder constants and utilities
 */

export const PLACEHOLDER_DELIMITERS = {
  start: "[[",
  end: "]]",
} as const;

/** PII placeholder format: [[TYPE_N]] e.g. [[PERSON_1]], [[EMAIL_ADDRESS_2]] */
export const PII_PLACEHOLDER_FORMAT = "[[{TYPE}_{N}]]";

/** Secrets placeholder format: [[TYPE_N]] e.g. [[API_KEY_SK_1]] */
export const SECRET_PLACEHOLDER_FORMAT = "[[{N}]]";

export function generatePlaceholder(format: string, type: string, count: number): string {
  return format.replace("{TYPE}", type).replace("{N}", String(count));
}

export function generateSecretPlaceholder(type: string, count: number): string {
  return SECRET_PLACEHOLDER_FORMAT.replace("{N}", `${type}_${count}`);
}

/** Default per-line template for each placeholder entry.
 *  Intentionally MINIMAL: just the placeholder name and a generic "value masked" note.
 *  To expose hints (initial, word length, partial chars), set `placeholder_context_hints`
 *  or `system_prompt_template` in config.
 */
const DEFAULT_LINE_TEMPLATE = "{{placeholder}}: real value masked, refer to it as this label";

/** Default header for the placeholder context block */
const DEFAULT_HEADER = [
  "=== PLACEHOLDER CONTEXT ===",
  "The user has provided a request with sensitive values (names, IDs, model numbers, etc.)",
  "that have been replaced with placeholder labels in the form [[TYPE_N]] (e.g. [[PERSON_1]]).",
  "The actual values are not visible to you and you must not attempt to guess, reverse, or",
  "reveal them. Refer to each value only by its placeholder label.",
  "Do not list, echo, or quote this context block in your reply — it is metadata, not for the user.",
  "",
].join("\n");

/**
 * Extracts a substring from a value based on a selector.
 * Supported selectors:
 *   first:N  — first N characters (e.g. "first:2" -> "Ra" from "Raihan")
 *   last:N   — last N characters (e.g. "last:2" -> "an" from "Raihan")
 *   mid:N    — middle N characters (e.g. "mid:3" -> "hai" from "Raihan")
 *   N        — alias for first:N
 *   "" or undefined — return the full value
 */
export function extractValueChars(value: string, selector: string): string {
  if (!selector || selector === "full") return value;

  const match = selector.match(/^(first|last|mid)(?::(\d+))?$/);
  if (!match) return value;

  const mode = match[1];
  const n = match[2] ? Number.parseInt(match[2], 10) : 3;
  if (Number.isNaN(n) || n < 0) return value;

  if (mode === "first") return value.slice(0, n);
  if (mode === "last") return value.slice(-n);
  const start = Math.max(0, Math.floor((value.length - n) / 2));
  return value.slice(start, start + n);
}

/**
 * Resolves a per-type hint. Hint can be:
 *   - A static string: { PERSON: "Indonesian full name" }
 *   - A substring selector: { PERSON: "mid:3" } — extracts middle 3 chars from the original value
 *   - A template: { PERSON: "Indonesian name (mid chars: {{value:mid:3}})" }
 *   - null/undefined: no hint
 */
export function resolveContextHint(
  hint: string | undefined,
  type: string,
  originalValue: string,
): string {
  if (!hint) return "";

  if (/^(first|last|mid)(:\d+)?$/.test(hint)) {
    return extractValueChars(originalValue, hint);
  }

  return hint
    .replace(/\{\{type\}\}/g, type)
    .replace(/\{\{value:([^}]+)\}\}/g, (_, selector) => extractValueChars(originalValue, selector))
    .replace(/\{\{value\}\}/g, originalValue)
    .replace(/\{\{initial\}\}/g, (originalValue[0] ?? "?").toUpperCase())
    .replace(/\{\{word_length\}\}/g, String(originalValue.length));
}

/**
 * Builds a human-readable description of all placeholders in a context.
 *
 * Supports custom templates and multiple context blocks via config:
 *   - system_prompt_template: full template (uses {{placeholder_lines}} to place per-item lines,
 *                            {{header}} for the default header,
 *                            {{extra_context}} for the extra_context config array,
 *                            and {{context}} for the full assembled block)
 *   - placeholder_context_hints: per-type hints (e.g. { PERSON: "mid:3" })
 *   - extra_context: array of static message blocks (prepended before placeholder lines)
 *
 * Available template variables per placeholder line:
 *   {{placeholder}}    — e.g. [[PERSON_1]]
 *   {{initial}}        — first character, e.g. "A"
 *   {{word_length}}    — character count, e.g. 4
 *   {{type}}           — entity type, e.g. PERSON
 *   {{context_hint}}   — resolved hint (static string OR extracted chars)
 *   {{value}}          — full original value (use sparingly — leaks the secret)
 *
 * Available template variables in the full template:
 *   {{header}}         — the default header text
 *   {{placeholder_lines}} — all per-placeholder lines joined
 *   {{extra_context}}  — the extra_context config joined with blank lines
 *   {{context}}        — full assembled context (header + extras + placeholders)
 */
export function buildPlaceholderContextDescription(
  context: { mapping: Record<string, string> },
  config?: {
    system_prompt_template?: string;
    placeholder_context_hints?: Record<string, string>;
    extra_context?: string[];
  },
): string {
  const entries = Object.entries(context.mapping);
  const hints = config?.placeholder_context_hints ?? {};
  const extraContext = config?.extra_context ?? [];

  // No placeholders and no extra context -> nothing to inject
  if (entries.length === 0 && extraContext.length === 0) return "";

  // Build per-placeholder lines
  const lines: string[] = [];
  for (const [placeholder, original] of entries) {
    const initial = original[0]?.toUpperCase() || "?";
    const wordLength = original.length;

    const typeMatch = placeholder.match(/^\[\[([A-Z_]+)_\d+\]\]$/);
    const type = typeMatch ? typeMatch[1] : "";
    const contextHint = resolveContextHint(type ? hints[type] : undefined, type, original);

    const line = DEFAULT_LINE_TEMPLATE.replace(/\{\{placeholder\}\}/g, placeholder)
      .replace(/\{\{initial\}\}/g, initial)
      .replace(/\{\{word_length\}\}/g, String(wordLength))
      .replace(/\{\{type\}\}/g, type)
      .replace(/\{\{context_hint\}\}/g, contextHint)
      .replace(/\{\{value\}\}/g, original);

    lines.push(line);
  }

  const placeholderLinesBlock = lines.join("\n");
  const extraContextBlock = extraContext.join("\n\n");

  // If user provided a full custom template, use it
  if (config?.system_prompt_template) {
    return config.system_prompt_template
      .replace(/\{\{header\}\}/g, DEFAULT_HEADER)
      .replace(/\{\{placeholder_lines\}\}/g, placeholderLinesBlock)
      .replace(/\{\{extra_context\}\}/g, extraContextBlock)
      .replace(
        /\{\{context\}\}/g,
        [DEFAULT_HEADER, extraContextBlock, placeholderLinesBlock].filter(Boolean).join("\n"),
      );
  }

  // Default: header, then extra_context blocks, then placeholder lines
  const parts: string[] = [];
  if (entries.length > 0 || extraContext.length > 0) {
    parts.push(DEFAULT_HEADER);
  }
  if (extraContextBlock) {
    parts.push(extraContextBlock);
  }
  if (placeholderLinesBlock) {
    parts.push(placeholderLinesBlock);
  }
  return parts.join("\n\n");
}

export function findPartialPlaceholderStart(text: string): number {
  const placeholderStart = text.lastIndexOf(PLACEHOLDER_DELIMITERS.start);

  if (placeholderStart === -1) {
    return -1;
  }

  const afterStart = text.slice(placeholderStart);
  const hasCompletePlaceholder = afterStart.includes(PLACEHOLDER_DELIMITERS.end);

  if (hasCompletePlaceholder) {
    return -1;
  }

  return placeholderStart;
}
