set -euo pipefail
mkdir -p /opt/launchpad-control /var/lib/launchpad-control /var/lib/launchpad-registry /var/lib/launchpad-registry-auth
touch /var/lib/launchpad-registry-auth/htpasswd
cat > /opt/launchpad-control/docker-compose.yml <<'YAML'
{{COMPOSE}}YAML
docker compose -f /opt/launchpad-control/docker-compose.yml up -d
install -m 0600 /dev/null /var/lib/launchpad-control/operator.token
printf %s {{OPERATOR_TOKEN_SH}} > /var/lib/launchpad-control/operator.token
