FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY apps/runtime/package.json apps/runtime/package.json
COPY packages/ai/package.json packages/ai/package.json
RUN pnpm install --frozen-lockfile
COPY apps/runtime apps/runtime
COPY packages/ai packages/ai
RUN pnpm --filter @ai-bunshin/runtime build

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/runtime/dist ./apps/runtime/dist
EXPOSE 8080
USER node
CMD ["node", "apps/runtime/dist/index.js"]
