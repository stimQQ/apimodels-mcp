# Used by MCP directories (Glama etc.) to build and inspect the server.
# End users do not need Docker: `npx -y apimodels-mcp` is the normal way to run it.
FROM node:22-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
RUN pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod --ignore-scripts

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# APIMODELS_API_KEY is supplied at run time; the server starts and lists its tools without it.
ENTRYPOINT ["node", "dist/index.js"]
