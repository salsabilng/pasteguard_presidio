import { getConfig, getPresidioUrls } from "../config";
import { HEALTH_CHECK_TIMEOUT_MS } from "../constants/timeouts";
import type { RequestExtractor } from "../masking/types";
import { getLanguageDetector, type SupportedLanguage } from "../services/language-detector";

export interface PIIEntity {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

export function filterWhitelistedEntities(
  text: string,
  entities: PIIEntity[],
  whitelist: string[],
): PIIEntity[] {
  if (whitelist.length === 0) return entities;

  return entities.filter((entity) => {
    const detectedText = text.slice(entity.start, entity.end);
    return !whitelist.some(
      (pattern) => pattern.includes(detectedText) || detectedText.includes(pattern),
    );
  });
}

interface AnalyzeRequest {
  text: string;
  language: string;
  entities?: string[];
  score_threshold?: number;
}

export interface PIIDetectionResult {
  hasPII: boolean;
  spanEntities: PIIEntity[][];
  allEntities: PIIEntity[];
  scanTimeMs: number;
  language: SupportedLanguage;
  languageFallback: boolean;
  detectedLanguage?: string;
  /** Languages scanned in multi-language mode */
  scannedLanguages?: SupportedLanguage[];
}

export class PIIDetector {
  private presidioUrls: string[];
  private currentIndex: number = 0;
  private scoreThreshold: number;
  private entityTypes: string[];
  private languageValidation?: { available: string[]; missing: string[] };
  private multiLanguageScan: boolean;
  private perUrlLanguages: SupportedLanguage[];

  constructor() {
    const config = getConfig();
    this.presidioUrls = getPresidioUrls(config);
    this.scoreThreshold = config.pii_detection.score_threshold;
    this.entityTypes = config.pii_detection.entities;
    this.multiLanguageScan = config.pii_detection.multi_language_scan;
    this.perUrlLanguages = config.pii_detection.presidio_url_languages;
  }

  private getNextUrl(): string {
    const url = this.presidioUrls[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.presidioUrls.length;
    return url;
  }

  private async callPresidioAnalyze(
    baseUrl: string,
    text: string,
    language: string,
  ): Promise<PIIEntity[]> {
    const analyzeEndpoint = `${baseUrl}/analyze`;

    const request: AnalyzeRequest = {
      text,
      language,
      entities: this.entityTypes,
      score_threshold: this.scoreThreshold,
    };

    const response = await fetch(analyzeEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Presidio API error at ${baseUrl}: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    return (await response.json()) as PIIEntity[];
  }

  /**
   * Round-robin: one Presidio URL, one language (detected or fallback).
   * Used when multi_language_scan = false.
   */
  async detectPII(text: string, language: SupportedLanguage): Promise<PIIEntity[]> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.presidioUrls.length; attempt++) {
      const url = this.getNextUrl();
      try {
        return await this.callPresidioAnalyze(url, text, language);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[PII] Presidio ${url} failed, trying next instance...`);
      }
    }

    if (lastError) {
      throw new Error(
        `Failed to connect to any Presidio instance (${this.presidioUrls.join(", ")}): ${lastError.message}`,
      );
    }
    throw new Error("All Presidio instances failed");
  }

  /**
   * Multi-language: send text to ALL configured (URL, language) pairs in parallel,
   * merge results, deduplicate overlapping matches. Used when multi_language_scan = true.
   */
  private async detectPIIMultiLanguage(
    text: string,
  ): Promise<{ entities: PIIEntity[]; scannedLanguages: SupportedLanguage[] }> {
    // Build (url, language) pairs.
    // If presidio_url_languages is configured, use it. Otherwise pair each URL with the
    // first language from the languages list.
    const config = getConfig();
    const pairs: { url: string; language: SupportedLanguage }[] = [];

    if (this.perUrlLanguages.length === this.presidioUrls.length) {
      // Explicit per-URL language mapping
      for (let i = 0; i < this.presidioUrls.length; i++) {
        pairs.push({ url: this.presidioUrls[i], language: this.perUrlLanguages[i] });
      }
    } else if (config.pii_detection.languages.length === this.presidioUrls.length) {
      // Auto: pair each URL with the language at the same index
      for (let i = 0; i < this.presidioUrls.length; i++) {
        pairs.push({ url: this.presidioUrls[i], language: config.pii_detection.languages[i] });
      }
    } else {
      // Fallback: send to all URLs with all languages (cartesian product, deduplicated)
      for (const url of this.presidioUrls) {
        for (const lang of config.pii_detection.languages) {
          pairs.push({ url, language: lang });
        }
      }
    }

    const results = await Promise.allSettled(
      pairs.map(async ({ url, language }) => {
        const entities = await this.callPresidioAnalyze(url, text, language);
        return entities;
      }),
    );

    // Merge all successful results
    const allEntities: PIIEntity[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        allEntities.push(...r.value);
      } else {
        console.warn(`[PII] One Presidio scan failed: ${r.reason}`);
      }
    }

    // Deduplicate: keep the highest-score entity for overlapping ranges
    const deduped = this.deduplicateEntities(allEntities);

    return {
      entities: deduped,
      scannedLanguages: [...new Set(pairs.map((p) => p.language))],
    };
  }

  /** Deduplicate overlapping entities, keeping the highest-score one */
  private deduplicateEntities(entities: PIIEntity[]): PIIEntity[] {
    if (entities.length === 0) return [];

    // Sort by score descending so highest-score wins
    const sorted = [...entities].sort((a, b) => b.score - a.score);
    const kept: PIIEntity[] = [];

    const overlaps = (a: PIIEntity, b: PIIEntity): boolean => {
      return a.start < b.end && b.start < a.end;
    };

    for (const entity of sorted) {
      // Skip if this entity overlaps with an already-kept higher-score entity
      const hasOverlap = kept.some((k) => overlaps(k, entity));
      if (!hasOverlap) kept.push(entity);
    }

    return kept.sort((a, b) => a.start - b.start);
  }

  async analyzeRequest<TRequest, TResponse>(
    request: TRequest,
    extractor: RequestExtractor<TRequest, TResponse>,
  ): Promise<PIIDetectionResult> {
    const startTime = Date.now();
    const config = getConfig();

    const spans = extractor.extractTexts(request);

    const messageSpans = spans.filter((span) => span.messageIndex >= 0);
    const langText = messageSpans.map((s) => s.text).join("\n");
    const langResult = langText
      ? getLanguageDetector().detect(langText)
      : { language: config.pii_detection.fallback_language, usedFallback: true };

    const scanRoles = config.pii_detection.scan_roles
      ? new Set(config.pii_detection.scan_roles)
      : null;
    const whitelist = config.masking.whitelist;

    let allScannedLanguages: SupportedLanguage[] | undefined;

    const spanEntities: PIIEntity[][] = await Promise.all(
      spans.map(async (span) => {
        if (scanRoles && span.role && !scanRoles.has(span.role)) {
          return [];
        }
        if (!span.text) return [];

        let entities: PIIEntity[];
        if (this.multiLanguageScan) {
          const result = await this.detectPIIMultiLanguage(span.text);
          entities = result.entities;
          if (allScannedLanguages) {
            for (const l of result.scannedLanguages) {
              if (!allScannedLanguages.includes(l)) allScannedLanguages.push(l);
            }
          } else {
            allScannedLanguages = [...result.scannedLanguages];
          }
        } else {
          entities = await this.detectPII(span.text, langResult.language);
        }
        return filterWhitelistedEntities(span.text, entities, whitelist);
      }),
    );

    const allEntities = spanEntities.flat();

    const result: PIIDetectionResult = {
      hasPII: allEntities.length > 0,
      spanEntities,
      allEntities,
      scanTimeMs: Date.now() - startTime,
      language: langResult.language,
      languageFallback: langResult.usedFallback,
      detectedLanguage: langResult.detectedLanguage,
    };

    if (allScannedLanguages) {
      result.scannedLanguages = allScannedLanguages;
    }

    return result;
  }

  async healthCheck(): Promise<boolean> {
    for (const url of this.presidioUrls) {
      try {
        const response = await fetch(`${url}/health`, {
          method: "GET",
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        if (response.ok) return true;
      } catch {
        // Try next instance
      }
    }
    return false;
  }

  async waitForReady(maxRetries = 30, delayMs = 1000): Promise<boolean> {
    for (let i = 1; i <= maxRetries; i++) {
      if (await this.healthCheck()) {
        return true;
      }
      if (i < maxRetries) {
        if (i === 1) {
          process.stdout.write("[STARTUP] Waiting for Presidio");
        } else if (i % 5 === 0) {
          process.stdout.write(".");
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    process.stdout.write("\n");
    return false;
  }

  async isLanguageSupported(url: string, language: string): Promise<boolean> {
    try {
      const response = await fetch(`${url}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "test", language, entities: ["PERSON"] }),
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });

      if (response.ok) return true;

      const errorText = await response.text();
      return !errorText.includes("No matching recognizers");
    } catch {
      return false;
    }
  }

  async validateLanguages(languages: string[]): Promise<{
    available: string[];
    missing: string[];
  }> {
    const results = await Promise.all(
      languages.map(async (lang) => ({
        lang,
        supported: await this.isLanguageSupported(this.presidioUrls[0], lang),
      })),
    );

    this.languageValidation = {
      available: results.filter((r) => r.supported).map((r) => r.lang),
      missing: results.filter((r) => !r.supported).map((r) => r.lang),
    };

    return this.languageValidation;
  }

  getLanguageValidation(): { available: string[]; missing: string[] } | undefined {
    return this.languageValidation;
  }
}

let detectorInstance: PIIDetector | null = null;

export function getPIIDetector(): PIIDetector {
  if (!detectorInstance) {
    detectorInstance = new PIIDetector();
  }
  return detectorInstance;
}
