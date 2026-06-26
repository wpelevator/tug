set -euo pipefail
mkdir -p /opt/launchpad-control /var/lib/launchpad-control
cat > /opt/launchpad-control/docker-compose.yml <<'YAML'
{{COMPOSE}}YAML
docker compose -f /opt/launchpad-control/docker-compose.yml up -d
install -m 0600 /dev/null /var/lib/launchpad-control/operator.token
printf %s {{OPERATOR_TOKEN_SH}} > /var/lib/launchpad-control/operator.token
