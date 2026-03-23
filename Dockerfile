FROM node:22-bookworm-slim AS base

WORKDIR /app

FROM base AS deps

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json

RUN npm ci

FROM deps AS build

COPY packages/core packages/core
COPY packages/server packages/server

RUN npm run build --workspace @all-api-hub/core --workspace @all-api-hub/server
RUN npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.58.2-noble AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist

EXPOSE 3000

CMD ["node", "packages/server/dist/index.js"]
