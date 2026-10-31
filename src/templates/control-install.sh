set -eu
mkdir -p /opt/tug-control /var/lib/tug-control
cat > /opt/tug-control/docker-compose.yml <<'YAML'
{{COMPOSE}}YAML
docker compose -f /opt/tug-control/docker-compose.yml up -d
install -m 0600 /dev/null /var/lib/tug-control/operator.token
printf %s {{OPERATOR_TOKEN_SH}} > /var/lib/tug-control/operator.token
