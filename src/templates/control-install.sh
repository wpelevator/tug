set -eu
mkdir -p /opt/tug-control
docker volume create tug-control >/dev/null
cat > /opt/tug-control/docker-compose.yml <<'YAML'
{{COMPOSE}}YAML
echo '{{MARKER}}Pulling the control image and starting control'
docker compose -f /opt/tug-control/docker-compose.yml up -d
echo '{{MARKER}}Waiting for control to create its CA'
# Wait for the CA so credential issuance does not race the first start.
for i in $(seq 1 60); do
  docker exec {{CONTAINER_SH}} test -s /data/pki/ca.crt 2>/dev/null && exit 0
  sleep 1
done
echo 'control did not create its CA in time; check: docker logs {{CONTAINER_SH}}' >&2
exit 1
