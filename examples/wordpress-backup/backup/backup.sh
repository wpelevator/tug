#!/bin/sh
# Back up a WordPress site to an encrypted restic repository.
#
#   backup.sh schedule  run forever, one backup per day at BACKUP_AT_UTC (default 03:30 UTC)
#   backup.sh once      run one backup now and exit non-zero on failure
#   backup.sh health    Docker HEALTHCHECK: fail when the last success is too old
#
# Required environment: RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
# Database dump: DB_HOST (default db; set it empty on a node without the database) plus DB_USER, DB_NAME and DB_PASSWORD.
# Files: BACKUP_PATHS is a space-separated list of directories to archive (default /data/wp-content). Mount each volume
# read-only in the container and add its path to the list. BACKUP_HOST names the node in restic snapshots.
set -eu
set -o pipefail

DB_HOST="${DB_HOST-db}"
DB_NAME="${DB_NAME:-wordpress}"
DB_USER="${DB_USER:-wordpress}"
BACKUP_PATHS="${BACKUP_PATHS:-/data/wp-content}"
BACKUP_HOST="${BACKUP_HOST:-wordpress}"
BACKUP_AT_UTC="${BACKUP_AT_UTC:-03:30}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-30}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${KEEP_MONTHLY:-6}"
STATE_DIR=/tmp/backup-state

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

ping_url() { [ -n "${BACKUP_PING_URL:-}" ] && wget -q -T 10 -O /dev/null "$BACKUP_PING_URL$1" || true; }

require() {
  for name in "$@"; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || die "$name is not set; set it with tug secret-set $name"
  done
}

run_backup() {
  require RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  [ -z "$DB_HOST" ] || require DB_PASSWORD
  for path in $BACKUP_PATHS; do [ -d "$path" ] || die "$path is not mounted"; done
  restic unlock >/dev/null 2>&1 || true
  if ! restic cat config >/dev/null 2>&1; then
    log "repository not reachable or not initialised, trying restic init"
    restic init || die "cannot open or initialise $RESTIC_REPOSITORY"
  fi

  if [ -n "$DB_HOST" ]; then
    log "dumping database $DB_NAME from $DB_HOST"
    # --skip-ssl: the dump travels over the project's private Compose network on this node.
    # MYSQL_PWD keeps the password out of the process list.
    MYSQL_PWD="$DB_PASSWORD" mariadb-dump --host="$DB_HOST" --user="$DB_USER" --skip-ssl \
      --single-transaction --quick --routines --triggers --events --hex-blob --default-character-set=utf8mb4 \
      "$DB_NAME" | restic backup --stdin --stdin-filename "$DB_NAME.sql" --host "$BACKUP_HOST" --tag db \
      || die "database dump failed"
  fi

  log "backing up $BACKUP_PATHS"
  # shellcheck disable=SC2086
  restic backup $BACKUP_PATHS --host "$BACKUP_HOST" --tag files || die "files backup failed"

  log "applying retention (daily $KEEP_DAILY, weekly $KEEP_WEEKLY, monthly $KEEP_MONTHLY)"
  restic forget --group-by host,tags --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --prune \
    || die "retention failed"

  if [ "$(date -u +%u)" = 7 ]; then
    log "weekly integrity check (metadata plus 5% of data)"
    restic check --read-data-subset=5% || die "restic check failed"
  fi
  mkdir -p "$STATE_DIR" && touch "$STATE_DIR/last_success"
  log "ok"
}

# Runs one backup and reports to the optional ping URL. Returns non-zero on failure.
backup_once() {
  # The subshell keeps die()'s exit from ending the schedule loop.
  if (run_backup); then ping_url ""; else ping_url "/fail"; return 1; fi
}

seconds_until() {
  now=$(( $(date -u +%s) % 86400 ))
  hh="${BACKUP_AT_UTC%%:*}"; mm="${BACKUP_AT_UTC##*:}"
  target=$(( ${hh#0} * 3600 + ${mm#0} * 60 ))
  wait=$(( target - now ))
  [ "$wait" -gt 0 ] || wait=$(( wait + 86400 ))
  echo "$wait"
}

health() {
  mkdir -p "$STATE_DIR"
  [ -e "$STATE_DIR/started" ] || touch "$STATE_DIR/started"
  # Healthy while the newest of last_success and started is younger than the limit.
  [ -n "$(find "$STATE_DIR" -type f \( -name last_success -o -name started \) -mmin "-$(( BACKUP_MAX_AGE_HOURS * 60 ))")" ] || exit 1
  # A container older than the limit with no success at all is also unhealthy: started is never refreshed.
}

case "${1:-schedule}" in
  once) backup_once ;;
  health) health ;;
  schedule)
    mkdir -p "$STATE_DIR" && touch "$STATE_DIR/started"
    log "scheduled daily at $BACKUP_AT_UTC UTC"
    [ "${BACKUP_ON_START:-0}" = 1 ] && { backup_once || log "first backup failed, will retry at the next window"; }
    while true; do
      sleep "$(seconds_until)"
      backup_once || log "backup failed, will retry at the next window"
    done
    ;;
  *) die "usage: backup.sh schedule|once|health" ;;
esac
