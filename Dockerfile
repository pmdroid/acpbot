# acpbot — multi-stage image with compiled worker + host binaries.
# Agents (grok/claude/codex/opencode) are NOT baked in; mount them or install
# in a derived image. State and repos are expected via volumes.
#
# Build-arg ACPBOT_VERSION is set by CI (e.g. v0.1.0) for image labels / banner.

# ── build ──────────────────────────────────────────────────────────────────
FROM oven/bun:1 AS build
ARG ACPBOT_VERSION=dev
ENV ACPBOT_VERSION=${ACPBOT_VERSION}
WORKDIR /src

COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY skills ./skills

# Stamp version for runtime (optional import).
RUN printf 'export const ACPBOT_VERSION = "%s";\n' "$ACPBOT_VERSION" > src/version.gen.ts

# Linux target matches this image arch (x64 or arm64 host / buildx platform).
RUN mkdir -p /out \
  && bun build --compile --outfile=/out/acpbot src/main.ts \
  && bun build --compile --outfile=/out/acpbot-host src/acp-host/main.ts \
  && chmod +x /out/acpbot /out/acpbot-host

# ── runtime ────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
ARG ACPBOT_VERSION=dev
LABEL org.opencontainers.image.title="acpbot" \
      org.opencontainers.image.version="${ACPBOT_VERSION}" \
      org.opencontainers.image.description="Telegram control surface for ACP coding agents" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tini \
  && rm -rf /var/lib/apt/lists/*

# Optional: node/npx for Claude/Codex ACP adapters (install agents yourself or
# extend this image). Grok/OpenCode binaries should be mounted or layered in.
RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs npm \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /out/acpbot /out/acpbot-host /usr/local/bin/
COPY skills /app/skills
COPY docker/entrypoint.sh /usr/local/bin/acpbot-entrypoint
RUN chmod +x /usr/local/bin/acpbot-entrypoint

# Shared state: sockets, sessions, OAuth (must be a volume in compose).
ENV ACPBOT_STATE_DIR=/data/state \
    ACPBOT_STORE_PATH=/data/store.json

VOLUME ["/data", "/repos"]

# OAuth callback (host). Worker does not need published ports.
EXPOSE 8788

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/acpbot-entrypoint"]
CMD ["worker"]
