set -eu
# begin helpers (tests extract this block)
# Name the step that failed, because on a first boot nobody is watching and the log is all there is.
stage_name=''
stage() { stage_name="$1"; echo "tug-bootstrap: $1" >&2; }
trap 'status=$?; [ "$status" = 0 ] || [ -z "$stage_name" ] || echo "tug-bootstrap: failed during: $stage_name (exit $status)" >&2' EXIT
# Retry a network step with a growing pause: mirrors, DNS and the first-boot package lock are often briefly unavailable.
retry() {
  attempts="${TUG_BOOTSTRAP_RETRIES:-5}"; delay="${TUG_BOOTSTRAP_RETRY_DELAY:-5}"; n=1
  until "$@"; do
    rc=$?
    [ "$n" -lt "$attempts" ] || { echo "tug-bootstrap: giving up after $n attempts: $*" >&2; return "$rc"; }
    echo "tug-bootstrap: attempt $n failed; retrying in $((n * delay))s: $*" >&2
    sleep "$((n * delay))"; n=$((n + 1))
  done
}
# end helpers
# Neither nodes nor the control host need more than the Docker Engine: both run their containers with plain `docker run`.
if docker version >/dev/null 2>&1; then
  echo 'Docker Engine is already available.' >&2
  exit 0
fi
os_release="${TUG_OS_RELEASE:-/etc/os-release}"
[ -r "$os_release" ] || { echo 'Docker bootstrap supports Debian, Ubuntu, Fedora and RHEL-compatible distributions with systemd.' >&2; exit 20; }
. "$os_release"
unsupported() { echo "Unsupported Docker bootstrap $1; install Docker Engine manually." >&2; exit 20; }
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
# Preserve existing Docker installations.
if command -v docker >/dev/null 2>&1; then
  docker version >/dev/null 2>&1 || { echo 'Docker exists but is not accessible; repair/start it before installing Tug.' >&2; exit 20; }
  engine_present=true
else
  engine_present=false
fi
conflict() { echo "Conflicting package $1 is installed; review Docker's installation instructions before replacing it." >&2; exit 20; }
# TUG_MARKER is set by the CLI so this stage shows in its progress; cloud-init runs without it and prints the plain text.
echo "${TUG_MARKER:-}Installing Docker packages (this can take a few minutes)"
# Fetch with a bounded wait so a stalled connection fails and is retried instead of hanging the boot. The file is
# written beside its destination and moved into place, so a truncated download is never left where it would be trusted.
fetch() { retry curl -fsSL --connect-timeout 15 --max-time 120 "$1" -o "$2.part" && mv -f "$2.part" "$2"; }
if [ "$family" = apt ]; then
  [ -n "${VERSION_CODENAME:-}" ] || { echo 'OS release must declare VERSION_CODENAME.' >&2; exit 20; }
  stage 'checking for conflicting packages'
  export DEBIAN_FRONTEND=noninteractive
  # A first boot often runs unattended upgrades that hold the dpkg lock; wait for it rather than fail.
  aptget() { retry apt-get -o Acquire::Retries=3 -o DPkg::Lock::Timeout=300 "$@"; }
  if [ "$engine_present" = false ]; then
    for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
      if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then conflict "$package"; fi
    done
  fi
  stage 'adding the Docker apt repository'
  aptget update >&2
  aptget install -y ca-certificates curl >&2
  install -m 0755 -d /etc/apt/keyrings
  fetch "https://download.docker.com/linux/$repo_os/gpg" /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<REPO
Types: deb
URIs: https://download.docker.com/linux/$repo_os
Suites: $VERSION_CODENAME
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
REPO
  aptget update >&2
  stage 'installing Docker Engine'
  [ "$engine_present" = true ] || aptget install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin >&2
else
  stage 'checking for conflicting packages'
  if [ "$engine_present" = false ]; then
    for package in docker docker-client docker-client-latest docker-common docker-latest docker-logrotate docker-engine moby-engine podman-docker docker-compose; do
      if rpm -q "$package" >/dev/null 2>&1; then conflict "$package"; fi
    done
  fi
  # curl-minimal already provides curl on many EL images; installing curl over it conflicts.
  stage 'adding the Docker dnf repository'
  command -v curl >/dev/null 2>&1 || retry dnf install -y curl >&2
  fetch "https://download.docker.com/linux/$repo_os/docker-ce.repo" /etc/yum.repos.d/docker-ce.repo
  stage 'installing Docker Engine'
  [ "$engine_present" = true ] || retry dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin >&2
fi
stage 'starting Docker'
[ "$engine_present" = true ] || systemctl enable --now docker >&2
stage 'verifying Docker'
docker version >/dev/null
