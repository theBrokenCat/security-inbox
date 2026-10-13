#!/usr/bin/env bash
# Consistent SQLite copies of this checkout's inbox, taken inside the application image with
# SQLite's backup API (never a copy of the main file while the WAL is active).
#
#   scripts/backup.sh daily        daily copy; afterwards keeps the newest 7 valid daily copies
#   scripts/backup.sh pre-update   identified copy before an update or migration; never pruned
#   scripts/backup.sh status       latest valid copy; exits 1 when none is newer than 36 hours
#
# The backup directory must exist beforehand, private (0700) and writable by UID 1000. The
# container has no network, a read-only root and only the data and backup directories mounted.
# Environment: SECURITY_INBOX_BACKUP_DIR (default <repo>/backups/sqlite), SECURITY_INBOX_DATA_DIR
# (default <repo>/data), SECURITY_INBOX_BACKUP_IMAGE (default security-inbox:local),
# SECURITY_INBOX_BACKUP_APP_VERSION (default: the image revision label), SECURITY_INBOX_BACKUP_KEEP.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
data_dir="${SECURITY_INBOX_DATA_DIR:-$repo_root/data}"
backup_dir="${SECURITY_INBOX_BACKUP_DIR:-$repo_root/backups/sqlite}"
image="${SECURITY_INBOX_BACKUP_IMAGE:-security-inbox:local}"
keep="${SECURITY_INBOX_BACKUP_KEEP:-7}"
command="${1:-}"

case "$command" in
  daily | pre-update | status) ;;
  *)
    echo "usage: $0 daily|pre-update|status" >&2
    exit 2
    ;;
esac

if [ ! -d "$backup_dir" ]; then
  echo "Backup directory $backup_dir does not exist; create it with mode 0700 for UID 1000." >&2
  exit 1
fi
docker image inspect "$image" >/dev/null

run_cli() {
  docker run --rm --network none --read-only --tmpfs /tmp "$@"
}

if [ "$command" = status ]; then
  run_cli --mount "type=bind,source=$backup_dir,target=/backups,readonly" \
    "$image" node dist/src/storage/backup-cli.js status --dir /backups
  exit
fi

if [ ! -f "$data_dir/security-inbox.sqlite" ]; then
  echo "No database at $data_dir/security-inbox.sqlite." >&2
  exit 1
fi
if [ -n "${SECURITY_INBOX_BACKUP_APP_VERSION:-}" ]; then
  # Explicit: an invalid value is rejected rather than replaced.
  version="$SECURITY_INBOX_BACKUP_APP_VERSION"
else
  version="$(docker image inspect \
    --format '{{ with .Config.Labels }}{{ index . "org.opencontainers.image.revision" }}{{ end }}' "$image")"
  # A label unfit for a file name must not stop the daily copies until the next build.
  if ! [[ "$version" =~ ^[0-9A-Za-z._-]{1,40}$ ]]; then
    if [ -n "$version" ]; then echo "Image revision label unusable in a file name; recording unknown." >&2; fi
    version=unknown
  fi
fi

run_cli --mount "type=bind,source=$data_dir,target=/app/data" \
  --mount "type=bind,source=$backup_dir,target=/backups" \
  "$image" node dist/src/storage/backup-cli.js backup --kind "$command" \
  --db /app/data/security-inbox.sqlite --dir /backups \
  --app-version "$version" --keep "$keep"
