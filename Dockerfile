FROM node:22-bookworm-slim AS build
WORKDIR /app/viewer
COPY viewer/package.json viewer/package-lock.json ./
COPY viewer/scripts ./scripts
RUN npm ci
COPY viewer/index.html viewer/tsconfig.json viewer/vite.config.ts ./
COPY viewer/src ./src
COPY viewer/public ./public
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/viewer/dist /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
EXPOSE 80
