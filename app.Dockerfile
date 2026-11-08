FROM node:20-alpine AS builder

WORKDIR /app

COPY app/package*.json ./
RUN npm ci

COPY app/tsconfig.json app/vite.config.ts app/index.html ./
COPY app/src ./src
COPY app/css ./css
# src/cmp/App.tsx imports ../../../docs/about.md (repo-root docs/), which
# resolves to /docs inside this container (WORKDIR /app, 3 levels up) -
# it isn't under app/, so it's not copied by anything above and the
# build fails with "Could not resolve '../../../docs/about.md?raw'"
# without this.
COPY docs /docs

RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 CMD [ "curl", "-f", "http://localhost" ]