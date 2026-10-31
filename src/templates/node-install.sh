set -eu
mkdir -p /etc/tug /var/lib/tug
cat > /etc/tug/agent.env <<'ENV'
{{ENV}}ENV
chmod 0600 /etc/tug/agent.env
{{DOCKER_LOGIN}}
docker rm -f tug-agent >/dev/null 2>&1 || true
docker run -d --name tug-agent --restart unless-stopped --env-file /etc/tug/agent.env {{RUN_FLAGS}}-v /var/run/docker.sock:/var/run/docker.sock -v /var/lib/tug:/var/lib/tug {{IMAGE_SH}} agent
