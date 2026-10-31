FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY tools/scripts ./tools/scripts
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
# Keep Compose compatible with the Docker 20.x daemons used by the isolated-node tests.
ARG DOCKER_COMPOSE_VERSION=2.32.4
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io ca-certificates curl apache2-utils wireguard-tools iproute2 \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in amd64) compose_arch=x86_64 ;; arm64) compose_arch=aarch64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
  && mkdir -p /usr/local/lib/docker/cli-plugins \
  && curl -fsSL "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${compose_arch}" -o /usr/local/lib/docker/cli-plugins/docker-compose \
  && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
  && docker compose version \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY tools/scripts ./tools/scripts
ENTRYPOINT ["node", "dist/main.js"]
CMD ["control"]
