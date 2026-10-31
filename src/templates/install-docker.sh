set -eu
if docker version >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo 'Docker Engine and Compose are already available.' >&2
  exit 0
fi
[ "$(id -u)" = 0 ] || { echo 'Docker installation requires root; use a root SSH target.' >&2; exit 20; }
[ -r /etc/os-release ] || { echo 'Docker bootstrap supports Debian and Ubuntu with systemd.' >&2; exit 20; }
. /etc/os-release
case "$ID" in
  ubuntu|debian) ;;
  *) echo "Unsupported Docker bootstrap OS: $ID; install Docker Engine and Compose manually." >&2; exit 20 ;;
esac
case "$ID:${VERSION_CODENAME:-}" in
  ubuntu:jammy|ubuntu:noble|ubuntu:resolute|ubuntu:stonking|debian:bookworm|debian:trixie) ;;
  *) echo "Unsupported Docker bootstrap release: $ID ${VERSION_CODENAME:-unknown}; install Docker Engine and Compose manually." >&2; exit 20 ;;
esac
[ -d /run/systemd/system ] || { echo 'Docker bootstrap requires systemd.' >&2; exit 20; }
[ -n "${VERSION_CODENAME:-}" ] || { echo 'OS release must declare VERSION_CODENAME.' >&2; exit 20; }
export DEBIAN_FRONTEND=noninteractive
# Preserve existing Docker installations. Install only a missing Compose plugin.
if command -v docker >/dev/null 2>&1; then
  docker version >/dev/null 2>&1 || { echo 'Docker exists but is not accessible; repair/start it before installing Tug.' >&2; exit 20; }
  engine_present=true
else
  engine_present=false
  for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      echo "Conflicting package $package is installed; review Docker's installation instructions before replacing it." >&2
      exit 20
    fi
  done
fi
apt-get update >&2
apt-get install -y ca-certificates curl >&2
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $VERSION_CODENAME
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update >&2
if [ "$engine_present" = true ]; then
  apt-get install -y --no-upgrade --no-remove docker-compose-plugin >&2
else
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >&2
  systemctl enable --now docker >&2
fi
docker version >/dev/null
docker compose version >/dev/null
