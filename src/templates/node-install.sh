set -eu
docker rm -f tug-agent >/dev/null 2>&1 || true
# Pull here, not inside `docker run`, so the pull is a named stage and a locally loaded image is left alone.
echo '{{MARKER}}Pulling the agent image'
docker image inspect {{IMAGE_SH}} >/dev/null 2>&1 || docker pull --quiet {{IMAGE_SH}} >/dev/null
echo '{{MARKER}}Starting the agent'
docker run -d --name tug-agent --restart unless-stopped {{ENV_FLAGS}}{{RUN_FLAGS}}-v /var/run/docker.sock:/var/run/docker.sock -v tug-agent:/var/lib/tug {{IMAGE_SH}} agent
