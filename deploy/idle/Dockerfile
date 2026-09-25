# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
ENV HUSKY=0
ENV NPM_CONFIG_IGNORE_SCRIPTS=1

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

FROM dependencies AS build

COPY .swcrc tsconfig.json vite.config.ts index.html ./
COPY resources ./resources
COPY src ./src

ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}
ENV GAME_ENV=prod
ENV NUM_WORKERS=1
ENV DOMAIN=localhost
ENV TURNSTILE_SITE_KEY=1x00000000000000000000AA

RUN npm run build-prod
RUN test ! -e proprietary

FROM node:24-bookworm-slim AS runtime

ARG REPOSITORY_URL=https://github.com/owner/repository
LABEL org.opencontainers.image.source=${REPOSITORY_URL}
LABEL org.opencontainers.image.description="Server-authoritative idle multiplayer demo"

WORKDIR /app

# The server currently executes TypeScript with tsx, so the locked development
# dependencies are retained in this first image. They can be removed after a
# separate server emit/bundle exists.
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY --from=build /app/static ./static
COPY resources ./resources
COPY src ./src
COPY LICENSE LICENSE-ASSETS LICENSING.md NOTICE.md CREDITS.md ./

ARG GIT_COMMIT=unknown
RUN printf '%s\n' "${GIT_COMMIT}" > static/commit.txt

ENV NODE_ENV=production
ENV GAME_ENV=prod
ENV NUM_WORKERS=1
ENV DOMAIN=localhost
ENV TURNSTILE_SITE_KEY=1x00000000000000000000AA
ENV GIT_COMMIT=${GIT_COMMIT}
ENV CDN_BASE=""
ENV IDLE_DB_PATH=/var/lib/openfront-idle/idle.sqlite
ENV PERSISTENT_WORLD_DB_PATH=/var/lib/openfront-idle/idle.sqlite
ENV IDLE_DEPLOY_DRAIN_STATUS_PATH=/var/lib/openfront-idle/deployment-drain.status
ENV IDLE_ADMIN_ENABLED=false

EXPOSE 3000
VOLUME ["/var/lib/openfront-idle"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/idle/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "--import", "tsx", "src/server/Server.ts"]
