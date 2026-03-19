FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /app

COPY package.json package-lock.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json

RUN npm ci

COPY packages/core packages/core
COPY packages/server packages/server

RUN npm run build --workspace @all-api-hub/core --workspace @all-api-hub/server

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start", "--workspace", "@all-api-hub/server"]
