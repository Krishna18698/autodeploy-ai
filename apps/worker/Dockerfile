# Built from the repo root: docker build -f apps/worker/Dockerfile .
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker
# The root package.json references @autodeploy/api (integration tests); pnpm
# only needs its manifest to resolve the workspace, not its code.
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter @autodeploy/worker...
RUN pnpm --filter @autodeploy/worker build \
 && pnpm --config.node-linker=hoisted --filter @autodeploy/worker deploy --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations
# The worker drives sibling build containers through the host Docker socket
# and applies AI patches with git.
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./
COPY --from=build /repo/apps/worker/dist ./dist
COPY packages/db/migrations ./migrations
USER node
EXPOSE 9464
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD node -e "fetch('http://127.0.0.1:9464/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "--import", "./dist/register.js", "dist/main.js"]
