FROM node:lts-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:lts-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends docker.io ca-certificates apache2-utils wireguard-tools iproute2 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
ENTRYPOINT ["node", "dist/main.js"]
CMD ["control"]
