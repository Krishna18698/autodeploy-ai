# Built from the repo root:  docker build -f apps/api/Dockerfile .
# Targets linux/arm64 in CI to match the Oracle Ampere A1 VM.
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @autodeploy/api...
COPY apps/api apps/api
RUN pnpm --filter @autodeploy/api build \
 && pnpm --filter @autodeploy/api deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./
COPY --from=build /repo/apps/api/dist ./dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
CMD ["node", "dist/main.js"]
