# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:26-bookworm-slim AS build
WORKDIR /app
# toolchain for native modules (better-sqlite3) when no prebuilt binary matches
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @thinkflow/server build \
  && pnpm --filter @thinkflow/web build \
  && pnpm --filter @thinkflow/server deploy --prod --legacy /out

# ---------- runtime ----------
FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3737 \
    DATA_DIR=/data \
    STORAGE_DRIVER=local \
    WEB_DIR=/app/public \
    MIGRATIONS_DIR=/app/drizzle
WORKDIR /app

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/apps/web/dist ./public

# Optional headless Chromium (PDF export and server-side Mermaid validation of the reports).
# Off by default (the image stays small; reports still come out as HTML/Markdown). Opt in with
#   docker build --build-arg WITH_CHROMIUM=true .
# It adds ~300 MB plus fonts; `--with-deps` installs the system libraries and fonts (accents!).
# playwright-core is pinned in apps/server/package.json, so the revision matches what it expects.
ARG WITH_CHROMIUM=false
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ "$WITH_CHROMIUM" = "true" ]; then \
      node ./node_modules/playwright-core/cli.js install --with-deps chromium-headless-shell \
      && rm -rf /var/lib/apt/lists/* \
      && chmod -R a+rX /ms-playwright; \
    fi

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3737
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
