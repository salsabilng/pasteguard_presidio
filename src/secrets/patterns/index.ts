import { apiKeysDetector } from "./api-keys";
import { createCustomRegexDetector } from "./custom-regex";
import { envVarsDetector } from "./env-vars";
import { privateKeysDetector } from "./private-keys";
import { tokensDetector } from "./tokens";
import type { PatternDetector } from "./types";

export const patternDetectors: PatternDetector[] = [
  privateKeysDetector,
  apiKeysDetector,
  tokensDetector,
  envVarsDetector,
];

export function createPatternDetectors(
  customPatterns?: { name: string; regex: string }[],
): PatternDetector[] {
  const detectors = [...patternDetectors];
  if (customPatterns && customPatterns.length > 0) {
    detectors.push(createCustomRegexDetector(customPatterns));
  }
  return detectors;
}

export type { PatternDetector, SecretEntityType, SecretsDetectionResult } from "./types";
export { detectPattern } from "./utils";
