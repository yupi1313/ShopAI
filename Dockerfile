# ShopAI server image. Multi-stage: build the pnpm workspace with dev deps,
# then install production deps only into a clean runtime layer. (pnpm prune
# in a workspace drops per-project node_modules links, so it is not used.)
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
ENV CI=true
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
# Drop every node_modules and the sources; the runtime stage re-installs prod deps.
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
 && find . -path ./node_modules -prune -o -type d -name src -prune -exec rm -rf {} + \
 && find . -name "*.test.js" -delete

FROM base AS runtime
ENV NODE_ENV=production
ENV LIVENESS_FILE=/tmp/shopai-alive
COPY --from=build /app /app
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
 && rm -rf /root/.cache /root/.local/share/pnpm/store 2>/dev/null || true
RUN chown -R node:node /app
USER node
WORKDIR /app/apps/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "const s=require('fs').statSync(process.env.LIVENESS_FILE);process.exit(Date.now()-s.mtimeMs<90000?0:1)"
CMD ["node", "dist/index.js"]
