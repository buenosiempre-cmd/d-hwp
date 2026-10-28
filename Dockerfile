FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS dependencies
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

FROM dependencies AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY studio/upstream.json ./studio/upstream.json
COPY scripts/prepare-studio.mjs ./scripts/prepare-studio.mjs
COPY .cache/studio.tar ./.cache/studio.tar
RUN npm run prepare:studio
COPY src ./src
COPY studio ./studio
COPY scripts ./scripts
COPY tsconfig*.json vite.config.ts ./
RUN npm run build && npm run build:dev \
    && node_modules/.bin/esbuild src/server/cloud/main.ts src/server/cloud/distributed.ts --bundle --platform=node --format=cjs '--external:@google-cloud/*' --external:google-auth-library --external:@playwright/test '--external:@rhwp/*' --external:jose --outdir=dist/cloud --out-extension:.js=.cjs

FROM dependencies AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 HOME=/tmp NODE_COMPILE_CACHE=/app/.node-compile-cache NODE_COMPILE_CACHE_PORTABLE=1
COPY --from=build /app/dist/cloud ./dist/cloud
COPY --from=build /app/dist/static-manifest.json ./dist/static-manifest.json
COPY --from=build /app/dist/editor ./dist/editor
COPY --from=build /app/dist/studio ./dist/studio
COPY --from=build /app/.cache/conversion ./.cache/conversion
COPY --from=build /app/src ./src
COPY scripts/healthcheck.mjs scripts/slack-preflight.ts ./scripts/
RUN mkdir -p /app/data /app/.node-compile-cache && chown node:node /app/data /app/.node-compile-cache && chmod 700 /app/data /app/.node-compile-cache
USER node
RUN node dist/cloud/main.cjs --warm-code
RUN node dist/cloud/distributed.cjs --warm-code
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "--import", "tsx", "src/server/main.ts"]

# Same runtime layers, with synthetic fixtures/tests added only to this verification target.
FROM runtime AS smoke
COPY tests ./tests
COPY slack/manifest.json ./slack/manifest.json
COPY playwright.config.ts ./playwright.config.ts
COPY scripts/run-tests.mjs scripts/verify-public-documents.mjs scripts/serve-viewer.mjs scripts/serve-desk.mjs scripts/container-smoke.mjs scripts/export-pages.mjs scripts/studio-bootstrap.mjs scripts/pages-headers.mjs scripts/public-site.mjs ./scripts/
COPY site ./site
COPY studio/adapters ./studio/adapters
CMD ["node", "scripts/container-smoke.mjs"]

# Default image never contains the smoke fixtures or test ingress.
FROM runtime AS release
