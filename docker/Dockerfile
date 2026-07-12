# PasteGuard - All-in-One Image
# Single container with Proxy + PII Detection
#
# Build: docker build -f docker/Dockerfile --build-arg LANGUAGES=en -t pasteguard:en .
# Run:   docker run -p 3000:3000 -v ./config.yaml:/pasteguard/config.yaml -v ./data:/pasteguard/data pasteguard:en

ARG LANGUAGES="en"

# =============================================================================
# Stage 1: Generate Presidio configuration files
# =============================================================================
FROM python:3.11-slim AS generator

WORKDIR /build

RUN pip install --no-cache-dir pyyaml

COPY docker/presidio/languages.yaml /build/
COPY docker/presidio/generate-configs.py /build/

ARG LANGUAGES
ARG SECONDARY_LANGUAGES=""
ARG CUSTOM_PATTERNS="[]"

# Build primary Presidio config (e.g., en, xx)
# Build secondary Presidio config (e.g., id) if SECONDARY_LANGUAGES is set —
# this enables multi-language scan with a separate Presidio instance per language
# running on different ports within the same container.
RUN python generate-configs.py \
    --languages="${LANGUAGES}" \
    --secondary-languages="${SECONDARY_LANGUAGES}" \
    --custom-patterns="${CUSTOM_PATTERNS}" \
    --registry=/build/languages.yaml \
    --output=/output

# =============================================================================
# Stage 2: Build Bun application
# =============================================================================
FROM oven/bun:1-slim AS bun-builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

# =============================================================================
# Stage 3: Final combined image
# =============================================================================
FROM mcr.microsoft.com/presidio-analyzer:latest

USER root

ARG LANGUAGES

# Install supervisor for process management
RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Rust only if Japanese is included
RUN if echo "${LANGUAGES}" | grep -q "ja"; then \
        apt-get update && apt-get install -y --no-install-recommends build-essential \
        && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
        && apt-get clean \
        && rm -rf /var/lib/apt/lists/*; \
    fi
ENV PATH="/root/.cargo/bin:${PATH}"

# Copy Bun binary from official image (uses baseline build for x64 compatibility)
# The official oven/bun images use baseline builds which only require SSE4.2,
# supporting older/low-power x86_64 CPUs (e.g., Intel Atom C3558R) that lack AVX2.
# See: https://github.com/sgasser/pasteguard/issues/70
COPY --from=bun-builder /usr/local/bin/bun /usr/local/bin/bun
ENV PATH="/usr/local/bin:${PATH}"

# Copy Presidio configuration
COPY --from=generator /output/nlp-config.yaml /app/presidio_analyzer/conf/default.yaml
COPY --from=generator /output/recognizers-config.yaml /app/presidio_analyzer/conf/default_recognizers.yaml
COPY --from=generator /output/analyzer-config.yaml /app/presidio_analyzer/conf/default_analyzer.yaml

# Copy secondary Presidio configuration (optional, only if SECONDARY_LANGUAGES was set).
# Each secondary instance reads from /app/presidio_analyzer/conf/secondary/ instead of /conf/.
# The generate-configs.py always creates the secondary/ dir (even if empty) when --secondary-languages is passed.
COPY --from=generator /output/secondary/ /app/presidio_analyzer/conf/secondary/

# Create a secondary app entrypoint that loads config from secondary/
# Only works when --secondary-languages is passed at build time.
# Also installs flask and pyyaml into the final image (needed by app_secondary.py).
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3-pip \
    && pip3 install --no-cache-dir --break-system-packages flask pyyaml \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY <<'PYEOF' /app/app_secondary.py
"""Secondary Presidio analyzer entrypoint.
Loads config from conf/secondary/ and runs on a different port (5003).
This mirrors the structure of the default /app/app.py shipped in the
presidio-analyzer base image, but reads its config from conf/secondary/.
"""
import os
import yaml
from flask import Flask, request, jsonify
from presidio_analyzer import AnalyzerEngine, PatternRecognizer, Pattern
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_analyzer.recognizer_registry import RecognizerRegistry

CONF_DIR = "/app/presidio_analyzer/conf/secondary"


def _load_yaml(name: str) -> dict:
    path = os.path.join(CONF_DIR, name)
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return yaml.safe_load(f) or {}


def _build_recognizers(recognizers_conf: dict) -> list:
    """Build PatternRecognizer instances from recognizers-config.yaml entries."""
    recognizers = []
    for entry in recognizers_conf.get("recognizers", []):
        if entry.get("type") != "custom":
            continue  # predefined recognizers are already loaded by Presidio
        patterns = []
        for p in entry.get("patterns", []):
            patterns.append(Pattern(name=p["name"], regex=p["regex"], score=p.get("score", 0.85)))
        recognizer = PatternRecognizer(
            name=entry["name"],
            supported_language=entry["supported_languages"][0]["language"] if entry.get("supported_languages") else None,
            patterns=patterns,
            context=entry.get("context", []),
            deny_list=entry.get("deny_list", []),
        )
        recognizers.append(recognizer)
    return recognizers


def create_app() -> Flask:
    nlp_conf = _load_yaml("default.yaml")
    analyzer_conf = _load_yaml("default_analyzer.yaml")
    recognizers_conf = _load_yaml("default_recognizers.yaml")

    # Build NLP engine from conf/secondary/default.yaml
    if nlp_conf:
        nlp_engine_provider = NlpEngineProvider(nlp_configuration=nlp_conf)
    else:
        # Fallback: hardcode Indonesian model
        nlp_engine_provider = NlpEngineProvider(
            nlp_configuration={
                "nlp_engine_name": "spacy",
                "models": [{"lang_code": "id", "model_name": "id_nergrit_indonesian_spacy"}],
            }
        )

    supported_languages = analyzer_conf.get("supported_languages", ["id"])
    default_score_threshold = analyzer_conf.get("default_score_threshold", 0)

    # Build recognizer registry with custom recognizers from config
    registry = RecognizerRegistry()
    registry.load_predefined_recognizers(supported_languages=supported_languages)
    custom_recognizers = _build_recognizers(recognizers_conf)
    for recognizer in custom_recognizers:
        registry.add_recognizer(recognizer)

    analyzer = AnalyzerEngine(
        nlp_engine=nlp_engine_provider.create_engine(),
        supported_languages=supported_languages,
        default_score_threshold=default_score_threshold,
        registry=registry,
    )

    app = Flask(__name__)

    @app.route("/health", methods=["GET"])
    def health():
        return jsonify({"status": "ok"})

    @app.route("/analyze", methods=["POST"])
    def analyze():
        body = request.get_json(force=True)
        text = body.get("text", "")
        language = body.get("language", "id")
        entities = body.get("entities")
        score_threshold = body.get("score_threshold")

        kwargs = {"language": language}
        if entities is not None:
            kwargs["entities"] = entities
        if score_threshold is not None:
            kwargs["score_threshold"] = score_threshold

        results = analyzer.analyze(text=text, **kwargs)
        return jsonify([
            {
                "entity_type": r.entity_type,
                "start": r.start,
                "end": r.end,
                "score": r.score,
            }
            for r in results
        ])

    @app.route("/recognizers", methods=["GET"])
    def recognizers():
        language = request.args.get("language", "id")
        all_recognizers = []
        for recognizer in analyzer.registry.get_recognizers(language=language):
            all_recognizers.append({
                "name": recognizer.name,
                "supported_language": recognizer.supported_language,
            })
        return jsonify(all_recognizers)

    return app
PYEOF

# Install spaCy models (combined primary + secondary models)
COPY --from=generator /output/install-models.sh /tmp/
RUN chmod +x /tmp/install-models.sh && /tmp/install-models.sh && rm /tmp/install-models.sh

# Copy Bun application to /pasteguard (separate from Presidio's /app)
WORKDIR /pasteguard
COPY --from=bun-builder /app/node_modules ./node_modules
COPY --from=bun-builder /app/src ./src
COPY --from=bun-builder /app/package.json ./
COPY --from=bun-builder /app/tsconfig.json ./
COPY config.example.yaml ./

# Create data directory and set permissions for UID 1000 (matches most Linux users)
RUN mkdir -p /pasteguard/data && chown -R 1000:1000 /pasteguard

# Copy supervisor configuration
COPY docker/supervisord.conf /etc/supervisor/conf.d/pasteguard.conf

# Copy the generator script for building custom recognizers at runtime
COPY docker/presidio/generate-custom-recognizer.py /app/generate-custom-recognizer.py

# Replace the default Presidio app.py with a wrapper that loads custom recognizers.
# This ensures custom_patterns (from config) are registered as Presidio PatternRecognizers.
# The wrapper preserves the original Presidio Flask endpoints (health, analyze, etc.)
# but adds custom recognizers from default_recognizers.yaml to the analyzer engine.
COPY <<'PYEOF' /app/app.py
"""PasteGuard Presidio primary entrypoint.
Wraps the standard Presidio app to register custom PatternRecognizers
from default_recognizers.yaml (generated by generate-configs.py).

Custom recognizers (from secrets_detection.custom_patterns in config.yaml)
get registered as Presidio PatternRecognizer instances with context-aware
scoring — Presidio's NLP engine uses the context words to boost confidence
when the regex match appears near relevant text (e.g. "tv", "model" for
TV_MODEL patterns).

This is the standard approach for adding custom regex to Presidio — the
same as writing a PatternRecognizer in generative config.py.
"""
import os
import yaml


def _load_yaml(name):
    """Load a YAML file from Presidio's conf directory."""
    path = os.path.join("/app/presidio_analyzer/conf", name)
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return yaml.safe_load(f) or {}


def _build_custom_recognizers(recognizers_conf):
    """Build PatternRecognizer instances from type:custom entries.

    These come from generate-configs.py which renders the custom_recognizers
    section of languages.yaml into Presidio's YAML format. Each entry has:
      - name: entity type name (e.g. "TV_MODEL")
      - patterns: [{name, regex, score}]
      - context: words that boost confidence (e.g. ["tv", "model"])
      - deny_list: false-positive values to ignore
    """
    from presidio_analyzer import PatternRecognizer, Pattern

    recognizers = []
    for entry in recognizers_conf.get("recognizers", []):
        if entry.get("type") != "custom":
            continue  # predefined recognizers are already loaded

        patterns = []
        for p in entry.get("patterns", []):
            patterns.append(
                Pattern(
                    name=p["name"],
                    regex=p["regex"],
                    score=p.get("score", 0.5),
                )
            )

        # Determine supported language (None = all languages)
        supported_lang = None
        if entry.get("supported_languages"):
            supported_lang = entry["supported_languages"][0].get("language")

        recognizer = PatternRecognizer(
            name=entry["name"],
            supported_language=supported_lang,
            patterns=patterns,
            context=entry.get("context", []),
            deny_list=entry.get("deny_list", []),
        )
        recognizers.append(recognizer)

    return recognizers


def create_app():
    """Build the analyzer engine with predefined + custom recognizers."""
    from presidio_analyzer import AnalyzerEngine
    from presidio_analyzer.nlp_engine import NlpEngineProvider
    from presidio_analyzer.recognizer_registry import RecognizerRegistry

    nlp_conf = _load_yaml("default.yaml")
    analyzer_conf = _load_yaml("default_analyzer.yaml")
    recognizers_conf = _load_yaml("default_recognizers.yaml")

    nlp_engine_provider = NlpEngineProvider(nlp_configuration=nlp_conf)
    supported_languages = analyzer_conf.get("supported_languages", ["xx"])
    default_score_threshold = analyzer_conf.get("default_score_threshold", 0)

    # Start with predefined recognizers for all configured languages
    registry = RecognizerRegistry()
    registry.load_predefined_recognizers(supported_languages=supported_languages)

    # Add custom recognizers (from generate-configs.py output)
    custom_recognizers = _build_custom_recognizers(recognizers_conf)
    for r in custom_recognizers:
        registry.add_recognizer(r)

    analyzer = AnalyzerEngine(
        nlp_engine=nlp_engine_provider.create_engine(),
        supported_languages=supported_languages,
        default_score_threshold=default_score_threshold,
        registry=registry,
    )

    # Delegate to the original Presidio Flask app factory (health, analyze endpoints)
    from presidio_analyzer.app import create_app as _orig
    return _orig()
PYEOF

# Switch to non-root user for runtime
USER 1000

# Environment defaults
ENV PRESIDIO_URL=http://localhost:5002
ENV PRESIDIO_URL_SECONDARY=http://localhost:5003
ENV PORT=5002
ENV WORKERS=1
ENV START_APP=true
ENV START_SECONDARY=false
ENV PASTEGUARD_LANGUAGES=${LANGUAGES}

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/pasteguard.conf"]
