/**
 * All supported secret entity types
 */
export type SecretEntityType =
  | "OPENSSH_PRIVATE_KEY"
  | "PEM_PRIVATE_KEY"
  | "API_KEY_SK"
  | "API_KEY_AWS"
  | "API_KEY_GITHUB"
  | "JWT_TOKEN"
  | "BEARER_TOKEN"
  | "ENV_PASSWORD"
  | "ENV_SECRET"
  | "CONNECTION_STRING";

export interface SecretsMatch {
  type: string;
  count: number;
}

/**
 * Location of a detected secret in text
 */
export interface SecretLocation {
  start: number;
  end: number;
  type: string;
}

export interface SecretsDetectionResult {
  detected: boolean;
  matches: SecretsMatch[];
  locations?: SecretLocation[];
}

export interface MessageSecretsResult {
  detected: boolean;
  matches: SecretsMatch[];
  spanLocations?: SecretLocation[][];
}

export interface PatternDetector {
  patterns: string[];
  detect(text: string, enabledTypes: Set<string>): SecretsDetectionResult;
}
