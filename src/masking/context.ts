/**
 * Placeholder context and text transformation utilities
 */

import { findPartialPlaceholderStart } from "../masking/placeholders";
import type { Span } from "./conflict-resolver";

export interface PlaceholderContext {
  mapping: Record<string, string>;
  reverseMapping: Record<string, string>;
  counters: Record<string, number>;
}

export interface MaskResult {
  masked: string;
  context: PlaceholderContext;
}

export function mergeContexts(a: PlaceholderContext, b: PlaceholderContext): PlaceholderContext {
  return {
    mapping: { ...a.mapping, ...b.mapping },
    reverseMapping: { ...a.reverseMapping, ...b.reverseMapping },
    counters: { ...a.counters, ...b.counters },
  };
}

export function createPlaceholderContext(): PlaceholderContext {
  return {
    mapping: {},
    reverseMapping: {},
    counters: {},
  };
}

export function incrementAndGenerate(
  type: string,
  context: PlaceholderContext,
  format: (type: string, count: number) => string,
): string {
  const count = (context.counters[type] || 0) + 1;
  context.counters[type] = count;
  return format(type, count);
}

export function restorePlaceholders(
  text: string,
  context: PlaceholderContext,
  formatValue?: (original: string) => string,
): string {
  let result = text;

  const placeholders = Object.keys(context.mapping).sort((a, b) => b.length - a.length);

  for (const placeholder of placeholders) {
    const originalValue = context.mapping[placeholder];
    const replacement = formatValue ? formatValue(originalValue) : originalValue;
    result = result.split(placeholder).join(replacement);
  }

  return result;
}

export function replaceWithPlaceholders<T extends Span>(
  text: string,
  items: T[],
  context: PlaceholderContext,
  getType: (item: T) => string,
  generatePlaceholder: (type: string, context: PlaceholderContext) => string,
  resolveConflicts: (items: T[]) => T[],
): string {
  if (items.length === 0) {
    return text;
  }

  const resolved = resolveConflicts(items);

  const sortedByStart = [...resolved].sort((a, b) => a.start - b.start);

  const itemPlaceholders = new Map<T, string>();
  for (const item of sortedByStart) {
    const originalValue = text.slice(item.start, item.end);

    let placeholder = context.reverseMapping[originalValue];

    if (!placeholder) {
      placeholder = generatePlaceholder(getType(item), context);
      context.mapping[placeholder] = originalValue;
      context.reverseMapping[originalValue] = placeholder;
    }

    itemPlaceholders.set(item, placeholder);
  }

  const sortedByEnd = [...resolved].sort((a, b) => b.start - a.start);

  let result = text;
  for (const item of sortedByEnd) {
    const placeholder = itemPlaceholders.get(item)!;
    result = result.slice(0, item.start) + placeholder + result.slice(item.end);
  }

  return result;
}

export function processStreamChunk(
  buffer: string,
  newChunk: string,
  context: PlaceholderContext,
  restore: (text: string, ctx: PlaceholderContext) => string,
): { output: string; remainingBuffer: string } {
  const combined = buffer + newChunk;

  const partialStart = findPartialPlaceholderStart(combined);

  if (partialStart === -1) {
    return {
      output: restore(combined, context),
      remainingBuffer: "",
    };
  }

  const safeToProcess = combined.slice(0, partialStart);
  const toBuffer = combined.slice(partialStart);

  return {
    output: restore(safeToProcess, context),
    remainingBuffer: toBuffer,
  };
}

export function flushBuffer(
  buffer: string,
  context: PlaceholderContext,
  restore: (text: string, ctx: PlaceholderContext) => string,
): string {
  if (!buffer) return "";
  return restore(buffer, context);
}
