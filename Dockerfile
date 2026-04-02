FROM node:22-bookworm-slim AS base

WORKDIR /app

FROM base AS deps

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts ./
COPY packages/browser/package.json packages/browser/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/worker/package.json packages/worker/package.json

RUN npm ci

FROM deps AS build

ARG TG_BOT_TOKEN
ARG TG_ADMIN_CHAT_ID
ARG ZEABUR_GIT_BRANCH
ARG ZEABUR_GIT_COMMIT_SHA
ARG ZEABUR_GIT_COMMIT_MESSAGE
ARG GIT_BRANCH
ARG GIT_COMMIT_SHA
ARG GIT_COMMIT_MESSAGE
ARG ZEABUR_SERVICE_NAME
ARG TZ=Asia/Shanghai

COPY packages/browser packages/browser
COPY packages/core packages/core
COPY packages/server packages/server

RUN node packages/server/scripts/zeabur-build-notify.mjs

FROM mcr.microsoft.com/playwright:v1.58.2-noble AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/browser/package.json ./packages/browser/package.json
COPY --from=build /app/packages/browser/dist ./packages/browser/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist

EXPOSE 3000

CMD ["node", "packages/server/dist/index.js"]
