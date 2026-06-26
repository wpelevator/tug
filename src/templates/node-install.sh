set -euo pipefail
mkdir -p /etc/launchpad /var/lib/launchpad
cat > /etc/launchpad/agent.env <<'ENV'
{{ENV}}ENV
chmod 0600 /etc/launchpad/agent.env
{{DOCKER_LOGIN}}
docker rm -f launchpad-agent >/dev/null 2>&1 || true
docker run -d --name launchpad-agent --restart unless-stopped --env-file /etc/launchpad/agent.env -v /var/run/docker.sock:/var/run/docker.sock -v /var/lib/launchpad:/var/lib/launchpad {{IMAGE_SH}} node src/agent.js
