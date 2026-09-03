# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS web-builder

ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_API_BASE_URL=/api/v1
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web ./apps/web
RUN pnpm --dir apps/web build

FROM ghcr.io/astral-sh/uv:0.12.9 AS uv

FROM python:3.12-slim-bookworm AS api-builder

ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1
WORKDIR /workspace
COPY --from=uv /uv /uvx /bin/
COPY apps/api/pyproject.toml apps/api/uv.lock ./apps/api/
RUN uv sync --directory apps/api --locked --no-dev --no-install-project

FROM python:3.12-slim-bookworm AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates libatomic1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 preview \
    && useradd --uid 10001 --gid preview --create-home --home-dir /home/preview preview

WORKDIR /app
COPY --from=web-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=api-builder /opt/venv /opt/venv
COPY --chown=10001:10001 apps/api ./apps/api
COPY --from=web-builder --chown=10001:10001 /workspace/apps/web/.next/standalone ./
COPY --from=web-builder --chown=10001:10001 /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-builder --chown=10001:10001 /workspace/apps/web/public ./apps/web/public
COPY --chown=10001:10001 scripts/preview-runtime.mjs scripts/preview-server.mjs ./scripts/

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/apps/api/src \
    PUBLIC_PREVIEW_MODE=1 \
    PREVIEW_API_PYTHON=/opt/venv/bin/python \
    PREVIEW_WEB_SERVER_ENTRY=apps/web/server.js \
    PORT=3000

USER 10001:10001
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e 'fetch(`http://127.0.0.1:${process.env.PORT || "3000"}/api/v1/health`).then(async (response) => { const body = await response.json(); if (!response.ok || body.agent_mode !== "OFFLINE_REPLAY" || body.public_preview_mode !== true || body.attachment_upload_enabled !== false) process.exit(1); }).catch(() => process.exit(1))'

CMD ["node", "scripts/preview-server.mjs"]
