FROM node:24-bookworm-slim
WORKDIR /app
# A fake VPS is a node: Docker Engine only. Agents use the Engine API, so there is no Compose plugin.
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io ca-certificates iptables bash curl wireguard-tools iproute2 iputils-ping \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY tools/docker/fake-vps/entrypoint.sh /usr/local/bin/fake-vps-entrypoint.sh
RUN chmod +x /usr/local/bin/fake-vps-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/fake-vps-entrypoint.sh"]
