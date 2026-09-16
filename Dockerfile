# ShopAI server image. Multi-stage: build the pnpm workspace, keep only prod deps.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /app

FROM base AS build
# pnpm prune refuses to purge node_modules without a TTY unless it thinks it is in CI.
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
RUN pnpm prune --prod

FROM base AS runtime
ENV NODE_ENV=production
ENV LIVENESS_FILE=/tmp/shopai-alive
COPY --from=build /app /app
RUN chown -R node:node /app
USER node
WORKDIR /app/apps/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "const s=require('fs').statSync(process.env.LIVENESS_FILE);process.exit(Date.now()-s.mtimeMs<90000?0:1)"
CMD ["node", "dist/index.js"]
