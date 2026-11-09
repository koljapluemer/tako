FROM node:22-bookworm-slim AS build
WORKDIR /app/viewer
COPY viewer/package.json viewer/package-lock.json ./
COPY viewer/scripts ./scripts
RUN npm ci
COPY viewer/index.html viewer/tsconfig.json viewer/vite.config.ts ./
COPY viewer/src ./src
COPY viewer/public ./public
RUN npm run build

FROM node:22-alpine AS stt
WORKDIR /app
COPY stt/server.mjs ./
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8787/health || exit 1
CMD ["node", "server.mjs"]

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/viewer/dist /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
EXPOSE 80
