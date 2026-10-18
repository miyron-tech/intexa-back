# syntax=docker/dockerfile:1

FROM node:22-slim AS base
WORKDIR /app
# npm 10 падает на этом дереве зависимостей (баг arborist "edgesOut")
RUN npm install -g npm@11

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Кириллица в подписях, которые мы накладываем на картинки через sharp
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig ffmpeg \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app/storage && chown node:node /app/storage
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
