import type { PatternDetector, SecretLocation, SecretsMatch } from "./types";

interface CustomPattern {
  name: string;
  regex: string;
}

export function createCustomRegexDetector(patterns: CustomPattern[]): PatternDetector {
  const compiled = patterns.map((p) => ({
    name: p.name,
    regex: new RegExp(p.regex, "g"),
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
