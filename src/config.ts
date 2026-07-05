import { existsSync, readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SUPPORTED_LANGUAGES } from "./constants/languages";

const LocalProviderSchema = z.object({
  type: z.enum(["openai", "ollama"]),
  api_key: z.string().optional(),
  base_url: z.string().url(),
  model: z.string(),
});

const OpenAIProviderSchema = z.object({
  base_url: z.string().url().default("https://api.openai.com/v1"),
  api_key: z.string().optional(),
});

const AnthropicProviderSchema = z.object({
  base_url: z.string().url().default("https://api.anthropic.com"),
  api_key: z.string().optional(),
});

const CodexProviderSchema = z.object({
  base_url: z.string().url().default("https://chatgpt.com/backend-api/codex"),
});

const DEFAULT_WHITELIST = ["You are Claude Code, Anthropic's official CLI for Claude."];

const MaskingSchema = z.object({
  show_markers: z.boolean().default(false),
  marker_text: z.string().default("[protected]"),
  whitelist: z
    .array(z.string())
    .default([])
    .transform((arr) => [...DEFAULT_WHITELIST, ...arr]),
  inject_placeholder_context: z.boolean().default(true),
  // Custom system prompt template for placeholder context injection.
  // Available variables: {{placeholder}}, {{initial}}, {{word_length}}, {{type}}, {{context_hint}}
  // {{context_hint}} comes from the placeholder_context_hints config below.
  system_prompt_template: z.string().optional(),
  // Per-type hints to pass to the AI about what each placeholder represents.
  // Example: { PERSON: "Indonesian full name", EMAIL_ADDRESS: "work email" }
  placeholder_context_hints: z.record(z.string(), z.string()).default({}),
  // Extra static context messages prepended to the placeholder context block.
  // Use this to tell the AI about privacy policy, formatting rules, etc.
  // Each entry is one message; multiple entries are joined with blank lines.
  // extra_context:
  //   - "Refer to people by role (e.g. 'the patient') rather than guessing from context."
  //   - "Never inline secrets in code — always use environment variables."
  extra_context: z.array(z.string()).default([]),
});

const LanguageEnum = z.enum(SUPPORTED_LANGUAGES);

const LanguagesSchema = z
  .union([z.array(LanguageEnum), z.string()])
  .transform((val) => {
    if (Array.isArray(val)) return val;
    return val.split(",").map((s) => s.trim()) as (typeof SUPPORTED_LANGUAGES)[number][];
  })
  .pipe(z.array(LanguageEnum))
  .default(["en"]);

const PIIDetectionSchema = z.object({
  enabled: z.boolean().default(true),
  presidio_url: z.string().url().default("http://localhost:5002"),
  presidio_urls: z.array(z.string().url()).default([]),
  languages: LanguagesSchema,
  fallback_language: LanguageEnum.default("en"),
  score_threshold: z.coerce.number().min(0).max(1).default(0.7),
  entities: z
    .array(z.string())
    .default([
      "PERSON",
      "EMAIL_ADDRESS",
      "PHONE_NUMBER",
      "CREDIT_CARD",
      "IBAN_CODE",
      "IP_ADDRESS",
      "LOCATION",
    ]),
  scan_roles: z.array(z.string()).optional(),
  // When true, every text is sent to ALL Presidio URLs in parallel using the
  // languages array (e.g. [en, id]) and the results are merged. Useful when
  // you have one Presidio instance per language and want to check all of them.
  // When false (default), each request goes to one URL via round-robin with
  // the detected/fallback language.
  multi_language_scan: z.boolean().default(false),
  // When multi_language_scan is true, this is the per-instance language mapping
  // (parallel array to presidio_urls). Length must match presidio_urls.
  // Example: presidio_urls: [a:5002, b:5002], presidio_url_languages: [en, id]
  presidio_url_languages: z.array(LanguageEnum).default([]),
});

const ServerSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().default("0.0.0.0"),
  request_timeout: z.coerce.number().int().min(0).default(600),
});

const LoggingSchema = z.object({
  database: z.string().default("./data/pasteguard.db"),
  retention_days: z.coerce.number().int().min(0).default(30),
  log_masked_content: z.boolean().default(true),
});

const DashboardAuthSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const DashboardSchema = z.object({
  enabled: z.boolean().default(true),
  auth: DashboardAuthSchema.optional(),
});

const CustomPatternSchema = z.object({
  name: z.string().min(1),
  regex: z.string().min(1),
});

const SecretsDetectionSchema = z.object({
  enabled: z.boolean().default(true),
  action: z.enum(["block", "mask", "route_local"]).default("mask"),
  entities: z.array(z.string()).default(["OPENSSH_PRIVATE_KEY", "PEM_PRIVATE_KEY"]),
  max_scan_chars: z.coerce.number().int().min(0).default(200000),
  log_detected_types: z.boolean().default(true),
  scan_roles: z.array(z.string()).optional(),
  custom_patterns: z.array(CustomPatternSchema).default([]),
});

const ConfigSchema = z
  .object({
    mode: z.enum(["route", "mask"]).default("route"),
    server: ServerSchema.default({}),
    providers: z.object({
      openai: OpenAIProviderSchema.default({}),
      anthropic: AnthropicProviderSchema.default({}),
      codex: CodexProviderSchema.default({}),
    }),
    local: LocalProviderSchema.optional(),
    masking: MaskingSchema.default({}),
    pii_detection: PIIDetectionSchema,
    logging: LoggingSchema.default({}),
    dashboard: DashboardSchema.default({}),
    secrets_detection: SecretsDetectionSchema.default({}),
  })
  .refine(
    (config) => {
      if (config.mode === "route") {
        return config.local !== undefined;
      }
      return true;
    },
    { message: "Route mode requires 'local' provider configuration" },
  )
  .refine(
    (config) => {
      if (config.secrets_detection.action === "route_local" && config.mode === "mask") {
        return false;
      }
      return true;
    },
    {
      message:
        "secrets_detection.action 'route_local' is not compatible with mode 'mask'. Use mode 'route' or change secrets_detection.action to 'block' or 'mask'",
    },
  );

export type Config = z.infer<typeof ConfigSchema>;
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderSchema>;
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderSchema>;
export type CodexProviderConfig = z.infer<typeof CodexProviderSchema>;
export type LocalProviderConfig = z.infer<typeof LocalProviderSchema>;
export type MaskingConfig = z.infer<typeof MaskingSchema>;
export type SecretsDetectionConfig = z.infer<typeof SecretsDetectionSchema>;
export type ServerConfig = z.infer<typeof ServerSchema>;

function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const [varName, defaultValue] = expr.split(":-");
    const envValue = process.env[varName];
    if (envValue) return envValue;
    if (defaultValue !== undefined) return defaultValue;
    console.warn(`Warning: Environment variable ${varName} is not set`);
    return "";
  });
}

function substituteEnvVarsInObject(obj: unknown): unknown {
  if (typeof obj === "string") return substituteEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(substituteEnvVarsInObject);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVarsInObject(value);
    }
    return result;
  }
  return obj;
}

export function loadConfig(configPath?: string): Config {
  const paths = configPath
    ? [configPath]
    : ["./config.yaml", "./config.yml", "./config.example.yaml"];

  let configFile: string | null = null;

  for (const path of paths) {
    if (existsSync(path)) {
      if (!statSync(path).isFile()) {
        throw new Error(
          `'${path}' is a directory, not a file. Run: cp config.example.yaml config.yaml`,
        );
      }
      configFile = readFileSync(path, "utf-8");
      break;
    }
  }

  if (!configFile) {
    throw new Error(
      `No config file found. Tried: ${paths.join(", ")}\nCreate a config.yaml file or copy config.example.yaml`,
    );
  }

  const rawConfig = parseYaml(configFile);
  const configWithEnv = substituteEnvVarsInObject(rawConfig);

  const result = ConfigSchema.safeParse(configWithEnv);

  if (!result.success) {
    console.error("Config validation errors:");
    for (const error of result.error.errors) {
      console.error(`  - ${error.path.join(".")}: ${error.message}`);
    }
    throw new Error("Invalid configuration");
  }

  return result.data;
}

let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

export function getPresidioUrls(config: Config): string[] {
  if (config.pii_detection.presidio_urls.length > 0) {
    return config.pii_detection.presidio_urls;
  }
  return [config.pii_detection.presidio_url];
}
