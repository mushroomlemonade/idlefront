#!/bin/sh
set -eu
umask 077

db_path=${IDLE_DB_PATH:-/var/lib/openfront-idle/idle.sqlite}
staging_dir=${IDLE_BACKUP_STAGING_DIR:-/var/lib/openfront-idle/backup-staging}
backup_host=${IDLE_BACKUP_HOST:-openfront-idle}

case "$db_path" in
    /var/lib/openfront-idle/*.sqlite) ;;
    *)
        echo "refusing to back up unexpected database path: $db_path" >&2
        exit 2
        ;;
esac

case "$staging_dir" in
    /var/lib/openfront-idle/backup-staging) ;;
    *)
        echo "refusing to use unexpected staging directory: $staging_dir" >&2
        exit 2
        ;;
esac

for command_name in sqlite3 restic; do
    if ! command -v "$command_name" > /dev/null 2>&1; then
        echo "missing required command: $command_name" >&2
        exit 3
    fi
done

if [ ! -f "$db_path" ]; then
    echo "database not found: $db_path" >&2
    exit 4
fi

if ! restic snapshots --no-cache > /dev/null 2>&1; then
    echo "restic repository is unavailable or uninitialized; run restic init during bootstrap" >&2
    exit 6
fi

install -d -m 0700 -o root -g root "$staging_dir"
snapshot=$(mktemp "${staging_dir}/idle.XXXXXXXX.sqlite")
cleanup() {
    rm -f -- "$snapshot"
}
trap cleanup EXIT HUP INT TERM

sqlite3 "$db_path" ".timeout 10000" ".backup '$snapshot'"
integrity=$(sqlite3 "$snapshot" "PRAGMA integrity_check;")
if [ "$integrity" != "ok" ]; then
    echo "SQLite integrity check failed: $integrity" >&2
    exit 5
fi

restic backup \
    --no-cache \
    --host "$backup_host" \
    --tag openfront-idle \
    --stdin \
    --stdin-filename openfront-idle/idle.sqlite < "$snapshot"

# The authority removes live raw receipts after 14 days. A 14-day encrypted
# snapshot window keeps the worst-case scheduled recovery-copy lifetime under
# the disclosed 30-day ceiling while preserving two weeks of restore points.
restic forget --no-cache --keep-within 14d --prune
restic check --no-cache

echo "Encrypted off-host SQLite backup, retention, and repository check completed"
