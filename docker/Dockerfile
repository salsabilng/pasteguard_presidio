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

# Build primary Presidio config (e.g., en)
# Build secondary Presidio config (e.g., id) if SECONDARY_LANGUAGES is set —
# this enables multi-language scan with a separate Presidio instance per language
# running on different ports within the same container.
RUN python generate-configs.py \
    --languages="${LANGUAGES}" \
    --secondary-languages="${SECONDARY_LANGUAGES}" \
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
# Only works when --secondary-languages is passed at build time
RUN cat > /app/app_secondary.py << 'PYEOF'
"""Secondary Presidio analyzer entrypoint.
Loads config from conf/secondary/ and runs on a different port (5003).
"""
import os

os.environ.setdefault("ANALYZER_CONF_FILE", "/app/presidio_analyzer/conf/secondary/default_analyzer.yaml")
os.environ.setdefault("NLP_CONF_FILE", "/app/presidio_analyzer/conf/secondary/default.yaml")
os.environ.setdefault("RECOGNIZERS_CONF_FILE", "/app/presidio_analyzer/conf/secondary/default_recognizers.yaml")

from presidio_analyzer.app import create_app  # noqa: E402
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
