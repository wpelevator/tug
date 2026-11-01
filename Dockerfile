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
# The Docker CLI loads and removes images on the control host. Nodes are managed through the Docker Engine API, so
# the Compose plugin is not installed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io ca-certificates wireguard-tools iproute2 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY tools/scripts ./tools/scripts
ENTRYPOINT ["node", "dist/main.js"]
