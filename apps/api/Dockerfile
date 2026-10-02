# Built from the repo root: docker build -f apps/api/Dockerfile .
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN pnpm install --frozen-lockfile --filter @autodeploy/api...
RUN pnpm --filter @autodeploy/api build \
 && pnpm --config.node-linker=hoisted --filter @autodeploy/api deploy --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./
COPY --from=build /repo/apps/api/dist ./dist
COPY packages/db/migrations ./migrations
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "--import", "./dist/register.js", "dist/main.js"]
