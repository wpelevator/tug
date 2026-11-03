FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY tools/scripts ./tools/scripts
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
# The Docker CLI loads and removes images on the control host. Nodes are managed through the Docker Engine API, so
# the Compose plugin is not installed.
RUN apk add --no-cache docker-cli ca-certificates
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY tools/scripts ./tools/scripts
ENTRYPOINT ["node", "dist/main.js"]
