set -eu
# The control state lives in this volume (see docs/control-plane.md); creating it first makes the container below
# mount an existing volume on an upgrade and a fresh one on a first install.
docker volume create tug-control >/dev/null
echo '{{MARKER}}Pulling the control image'
# Pull here, not inside `docker run`, so the pull is a named stage and a locally loaded image is left alone.
docker image inspect {{IMAGE_SH}} >/dev/null 2>&1 || docker pull --quiet {{IMAGE_SH}} >/dev/null
echo '{{MARKER}}Starting control'
# Replaces the running control, whether this script or an earlier Compose-based install created it. The data is in the
# volume, so only the container is recreated.
docker rm -f {{CONTAINER_SH}} >/dev/null 2>&1 || true
docker run -d --name {{CONTAINER_SH}} --restart unless-stopped -p {{PORT}}:8443 -e PORT=8443 -e TUG_DATA_DIR=/data -e TUG_CONTROL_URL={{CONTROL_URL_SH}} -e TUG_EXTRA_SANS={{EXTRA_SANS_SH}} -v tug-control:/data -v /var/run/docker.sock:/var/run/docker.sock {{IMAGE_SH}} control >/dev/null
# Control used to be a Compose project; nothing manages it through Compose any more.
docker network rm tug-control_default >/dev/null 2>&1 || true
rm -f /opt/tug-control/docker-compose.yml
rmdir /opt/tug-control >/dev/null 2>&1 || true
echo '{{MARKER}}Waiting for control to create its CA'
# Wait for the CA so credential issuance does not race the first start.
for i in $(seq 1 60); do
  docker exec {{CONTAINER_SH}} test -s /data/pki/ca.crt 2>/dev/null && exit 0
  sleep 1
done
echo 'control did not create its CA in time; check: docker logs {{CONTAINER_SH}}' >&2
exit 1
