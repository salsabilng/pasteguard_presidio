import type { PatternDetector, SecretLocation, SecretsMatch } from "./types";

interface CustomPattern {
  name: string;
  regex: string;
}

/**
 * Strips leading ^ and trailing $ from a regex pattern.
 * These anchors prevent matching embedded text (e.g. TV model inside a chat message).
 * Custom patterns should match anywhere in the text, not require the full string.
 */
function stripAnchors(pattern: string): string {
  let result = pattern;
  // Strip leading ^ (possibly with whitespace/newline flags)
  if (result.startsWith("^")) result = result.slice(1);
  // Strip trailing $ (possibly with whitespace/newline flags)
  if (result.endsWith("$")) result = result.slice(0, -1);
  return result;
}

export function createCustomRegexDetector(patterns: CustomPattern[]): PatternDetector {
  const compiled = patterns.map((p) => ({
    name: p.name,
    // Strip anchors so custom patterns match embedded text, not just full-string matches
    regex: new RegExp(stripAnchors(p.regex), "gi"),
  }));

  return {
    patterns: compiled.map((p) => p.name),

    detect(
      _text: string,
      _enabledTypes: Set<string>,
    ): {
      detected: boolean;
      matches: SecretsMatch[];
      locations?: SecretLocation[];
    } {
      const matches: SecretsMatch[] = [];
      const locations: SecretLocation[] = [];

      for (const { name, regex } of compiled) {
        regex.lastIndex = 0;

        let count = 0;
        for (const match of _text.matchAll(regex)) {
          if (match.index !== undefined) {
            count++;
            locations.push({
              start: match.index,
              end: match.index + match[0].length,
              type: name,
            });
          }
        }

        if (count > 0) {
          matches.push({ type: name, count });
        }
      }

      return {
        detected: matches.length > 0,
        matches,
        locations: locations.length > 0 ? locations : undefined,
      };
    },
  };
}
