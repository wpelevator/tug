set -eu
if docker version >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo 'Docker Engine and Compose are already available.' >&2
  exit 0
fi
os_release="${TUG_OS_RELEASE:-/etc/os-release}"
[ -r "$os_release" ] || { echo 'Docker bootstrap supports Debian, Ubuntu, Fedora and RHEL-compatible distributions with systemd.' >&2; exit 20; }
. "$os_release"
unsupported() { echo "Unsupported Docker bootstrap $1; install Docker Engine and Compose manually." >&2; exit 20; }
major="${VERSION_ID:-}"; major="${major%%.*}"
case "$ID" in
  ubuntu|debian)
    family=apt
    case "$ID:${VERSION_CODENAME:-}" in
      ubuntu:jammy|ubuntu:noble|ubuntu:resolute|ubuntu:stonking|debian:bookworm|debian:trixie) ;;
      *) unsupported "release: $ID ${VERSION_CODENAME:-unknown}" ;;
    esac
    repo_os=$ID ;;
  fedora)
    family=dnf; repo_os=fedora
    case "$major" in 42|43|44) ;; *) unsupported "release: $ID ${VERSION_ID:-unknown}" ;; esac ;;
  rhel|centos|rocky|almalinux)
    family=dnf
    # Docker publishes one EL repository per RHEL major; Rocky, AlmaLinux and CentOS Stream use the centos one.
    if [ "$ID" = rhel ]; then repo_os=rhel; else repo_os=centos; fi
    case "$major" in 9|10) ;; *) unsupported "release: $ID ${VERSION_ID:-unknown}" ;; esac ;;
  *) unsupported "OS: $ID" ;;
esac
# Print the selected package family and repository without touching the host (used by tests).
if [ "${TUG_BOOTSTRAP_DETECT:-}" = 1 ]; then echo "$family $repo_os"; exit 0; fi
[ "$(id -u)" = 0 ] || { echo 'Docker installation requires root; use a root SSH target.' >&2; exit 20; }
[ -d /run/systemd/system ] || { echo 'Docker bootstrap requires systemd.' >&2; exit 20; }
# Preserve existing Docker installations. Install only a missing Compose plugin.
if command -v docker >/dev/null 2>&1; then
  docker version >/dev/null 2>&1 || { echo 'Docker exists but is not accessible; repair/start it before installing Tug.' >&2; exit 20; }
  engine_present=true
else
  engine_present=false
fi
conflict() { echo "Conflicting package $1 is installed; review Docker's installation instructions before replacing it." >&2; exit 20; }
if [ "$family" = apt ]; then
  [ -n "${VERSION_CODENAME:-}" ] || { echo 'OS release must declare VERSION_CODENAME.' >&2; exit 20; }
  export DEBIAN_FRONTEND=noninteractive
  if [ "$engine_present" = false ]; then
    for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
      if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then conflict "$package"; fi
    done
  fi
  apt-get update >&2
  apt-get install -y ca-certificates curl >&2
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$repo_os/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<REPO
Types: deb
URIs: https://download.docker.com/linux/$repo_os
Suites: $VERSION_CODENAME
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
REPO
  apt-get update >&2
  if [ "$engine_present" = true ]; then
    apt-get install -y --no-upgrade --no-remove docker-compose-plugin >&2
  else
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >&2
  fi
else
  if [ "$engine_present" = false ]; then
    for package in docker docker-client docker-client-latest docker-common docker-latest docker-logrotate docker-engine moby-engine podman-docker docker-compose; do
      if rpm -q "$package" >/dev/null 2>&1; then conflict "$package"; fi
    done
  fi
  # curl-minimal already provides curl on many EL images; installing curl over it conflicts.
  command -v curl >/dev/null 2>&1 || dnf install -y curl >&2
  curl -fsSL "https://download.docker.com/linux/$repo_os/docker-ce.repo" -o /etc/yum.repos.d/docker-ce.repo
  if [ "$engine_present" = true ]; then
    dnf install -y docker-compose-plugin >&2
  else
    dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >&2
  fi
fi
[ "$engine_present" = true ] || systemctl enable --now docker >&2
docker version >/dev/null
docker compose version >/dev/null
