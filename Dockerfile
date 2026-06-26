FROM node:lts-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ docker.io ca-certificates apache2-utils && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY scripts ./scripts
CMD ["node", "src/control.js"]
