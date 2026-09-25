#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "openfront-idle deploy must run as root" >&2
    exit 1
fi

lock_file=/run/lock/openfront-idle-deploy.lock
exec 9> "$lock_file"
if ! /usr/bin/flock -w 600 9; then
    echo "another openfront-idle deployment still holds $lock_file" >&2
    exit 5
fi

image_ref=${1:-}
env_file=/etc/openfront-idle/openfront-idle.env
service=openfront-idle.service
health_url=http://127.0.0.1:3000/api/idle/health
rollback_dir=/var/backups/openfront-idle
drain_requested=false

if [ ! -f "$env_file" ]; then
    echo "missing $env_file; bootstrap the host before deploying" >&2
    exit 3
fi

allowed_repository=$(sed -n 's/^IDLE_IMAGE_REPOSITORY=//p' "$env_file" | tail -n 1)
if ! printf '%s\n' "$allowed_repository" | grep -Eq '^ghcr\.io/[a-z0-9._-]+/[a-z0-9._/-]+$'; then
    echo "missing or invalid IDLE_IMAGE_REPOSITORY in $env_file" >&2
    exit 2
fi
if ! printf '%s\n' "$image_ref" | grep -Eq '^ghcr\.io/[a-z0-9._-]+/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$' \
    || [ "${image_ref%@sha256:*}" != "$allowed_repository" ]; then
    echo "expected an immutable digest from $allowed_repository, got: $image_ref" >&2
    exit 2
fi

db_path=$(sed -n 's/^IDLE_DB_PATH=//p' "$env_file" | tail -n 1)
case "$db_path" in
    /var/lib/openfront-idle/*.sqlite) ;;
    *)
        echo "missing or unsafe IDLE_DB_PATH in $env_file: $db_path" >&2
        exit 2
        ;;
esac
persistent_world_db_path=$(sed -n 's/^PERSISTENT_WORLD_DB_PATH=//p' "$env_file" | tail -n 1)
if [ "$persistent_world_db_path" != "$db_path" ]; then
    echo "PERSISTENT_WORLD_DB_PATH must match the backed-up IDLE_DB_PATH: $persistent_world_db_path" >&2
    exit 2
fi
drain_status_path=$(sed -n 's/^IDLE_DEPLOY_DRAIN_STATUS_PATH=//p' "$env_file" | tail -n 1)
case "$drain_status_path" in
    /var/lib/openfront-idle/*.status) ;;
    *)
        echo "missing or unsafe IDLE_DEPLOY_DRAIN_STATUS_PATH in $env_file: $drain_status_path" >&2
        exit 2
        ;;
esac
drain_timeout=$(sed -n 's/^IDLE_DEPLOY_DRAIN_TIMEOUT_SECONDS=//p' "$env_file" | tail -n 1)
drain_timeout=${drain_timeout:-7200}
if ! printf '%s\n' "$drain_timeout" | grep -Eq '^[0-9]+$' \
    || [ "$drain_timeout" -lt 60 ] \
    || [ "$drain_timeout" -gt 86400 ]; then
    echo "IDLE_DEPLOY_DRAIN_TIMEOUT_SECONDS must be between 60 and 86400" >&2
    exit 2
fi
if ! command -v sqlite3 > /dev/null 2>&1; then
    echo "sqlite3 is required for a schema-safe deployment rollback" >&2
    exit 3
fi
install -d -m 0700 -o root -g root "$rollback_dir"

old_image=$(sed -n 's/^IDLE_IMAGE=//p' "$env_file" | tail -n 1)
tmp_file=$(mktemp "${env_file}.XXXXXX")
rollback_snapshot=
restore_tmp=
database_existed=false

cancel_deployment_drain() {
    docker kill --signal=USR1 openfront-idle > /dev/null 2>&1 || true
    rm -f -- "$drain_status_path"
    drain_requested=false
}

request_deployment_drain() {
    if ! systemctl is-active --quiet "$service"; then
        return 0
    fi
    # Compatibility for the first rollout: an older image has no SIGUSR2
    # handler, so signalling it would terminate Node instead of draining.
    if ! docker exec openfront-idle test -f /app/src/server/DeploymentDrainStatusFile.ts; then
        echo "Current image predates deployment draining; using the existing graceful stop for this one transition"
        return 0
    fi

    rm -f -- "$drain_status_path"
    echo "Requesting deployment drain (timeout ${drain_timeout}s)"
    docker kill --signal=USR2 openfront-idle > /dev/null
    drain_requested=true
    deadline=$(($(date +%s) + drain_timeout))
    next_report=0
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if ! systemctl is-active --quiet "$service"; then
            echo "authority stopped unexpectedly while deployment drain was pending" >&2
            return 1
        fi
        if [ -f "$drain_status_path" ]; then
            drain_line=$(cat "$drain_status_path")
            if printf '%s\n' "$drain_line" | grep -Eq '^openfront-drain-v1 [A-Za-z0-9_-]{1,64} (idle|draining|ready) [0-9]+ [0-9]+ [0-9]+ [0-9]+ [0-9]+ [0-9]+ [0-9]+ [0-9]+$'; then
                set -- $drain_line
                drain_state=$3
                blocking_games=$4
                managed_games=$5
                lobby_games=$6
                active_clients=$7
                workers_reported=$8
                workers_expected=$9
                pending_admissions=${10}
                if [ "$drain_state" = ready ]; then
                    echo "Deployment drain ready: managed=$managed_games clients=$active_clients workers=$workers_reported/$workers_expected"
                    return 0
                fi
                now=$(date +%s)
                if [ "$now" -ge "$next_report" ]; then
                    echo "Waiting for safe deployment window: blocking=$blocking_games lobbies=$lobby_games pending=$pending_admissions managed=$managed_games clients=$active_clients workers=$workers_reported/$workers_expected"
                    next_report=$((now + 30))
                fi
            fi
        fi
        sleep 2
    done

    echo "Deployment drain timed out; cancelling deployment and reopening game admission" >&2
    cancel_deployment_drain
    return 1
}

cleanup() {
    if [ "$drain_requested" = true ]; then
        cancel_deployment_drain || true
    fi
    if [ -n "$tmp_file" ]; then
        rm -f -- "$tmp_file"
    fi
    if [ -n "$restore_tmp" ]; then
        rm -f -- "$restore_tmp"
    fi
}
trap cleanup EXIT HUP INT TERM

discard_rollback_snapshot() {
    if [ -z "$rollback_snapshot" ]; then
        return 0
    fi
    rm -f -- "$rollback_snapshot" || return 1
    rollback_snapshot=
}

stop_authority() {
    if ! systemctl stop "$service"; then
        return 1
    fi
    if systemctl is-active --quiet "$service"; then
        return 1
    fi
    if ! docker info > /dev/null 2>&1; then
        return 1
    fi
    container_running=$(docker inspect --format '{{.State.Running}}' openfront-idle 2> /dev/null || true)
    if [ "$container_running" = true ]; then
        return 1
    fi
    drain_requested=false
    rm -f -- "$drain_status_path"
    return 0
}

write_image() {
    next_image=$1
    if [ -z "$tmp_file" ]; then
        tmp_file=$(mktemp "${env_file}.XXXXXX") || return 1
    fi
    awk -v image="$next_image" '
    BEGIN { replaced = 0 }
    /^IDLE_IMAGE=/ {
      if (!replaced) print "IDLE_IMAGE=" image
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print "IDLE_IMAGE=" image }
  ' "$env_file" > "$tmp_file" || return 1
    chown root:root "$tmp_file" || return 1
    chmod 0600 "$tmp_file" || return 1
    mv -f -- "$tmp_file" "$env_file" || return 1
    tmp_file=
}

echo "Pulling $image_ref"
docker pull "$image_ref"

if ! request_deployment_drain; then
    exit 8
fi

# A migration can make an older image unable to open the database. Quiesce the
# single writer and retain a verified pre-deploy database snapshot so rollback
# restores the image and its compatible schema as one operation.
if [ -f "$db_path" ]; then
    database_existed=true
    echo "Quiescing $service for a schema-safe rollback snapshot"
    if ! stop_authority; then
        echo "refusing to snapshot because the authority could not be confirmed stopped" >&2
        exit 6
    fi
    if ! rollback_snapshot=$(mktemp "${rollback_dir}/deploy-rollback.XXXXXXXX.sqlite"); then
        echo "failed to allocate pre-deploy database snapshot; restarting the current service" >&2
        systemctl start "$service" || true
        exit 6
    fi
    if ! sqlite3 "$db_path" ".timeout 10000" ".backup '$rollback_snapshot'"; then
        echo "failed to create pre-deploy database snapshot; restarting the current service" >&2
        discard_rollback_snapshot || echo "partial snapshot remains at $rollback_snapshot" >&2
        systemctl start "$service" || true
        exit 6
    fi
    if ! rollback_integrity=$(sqlite3 "$rollback_snapshot" "PRAGMA integrity_check;"); then
        echo "failed to check pre-deploy database snapshot; restarting the current service" >&2
        discard_rollback_snapshot || echo "unchecked snapshot remains at $rollback_snapshot" >&2
        systemctl start "$service" || true
        exit 6
    fi
    if [ "$rollback_integrity" != "ok" ]; then
        echo "pre-deploy database snapshot failed integrity: $rollback_integrity" >&2
        discard_rollback_snapshot || echo "invalid snapshot remains at $rollback_snapshot" >&2
        systemctl start "$service" || true
        exit 6
    fi
    if ! chown root:root "$rollback_snapshot" || ! chmod 0600 "$rollback_snapshot"; then
        echo "failed to secure pre-deploy database snapshot; restarting the current service" >&2
        echo "snapshot remains inside root-only $rollback_dir at $rollback_snapshot" >&2
        systemctl start "$service" || true
        exit 6
    fi
fi

if ! write_image "$image_ref"; then
    echo "failed to update image configuration; restarting the current service" >&2
    systemctl start "$service" || true
    if [ -n "$rollback_snapshot" ]; then
        echo "verified recovery snapshot retained at $rollback_snapshot" >&2
    fi
    exit 6
fi

restart_and_wait() {
    if ! systemctl restart "$service"; then
        return 1
    fi
    drain_requested=false
    rm -f -- "$drain_status_path"
    attempt=1
    while [ "$attempt" -le 30 ]; do
        if curl --fail --silent --show-error --max-time 3 "$health_url" > /dev/null; then
            return 0
        fi
        sleep 2
        attempt=$((attempt + 1))
    done
    return 1
}

if restart_and_wait; then
    if discard_rollback_snapshot; then
        echo "Deployment healthy: $image_ref"
        exit 0
    fi
    echo "CRITICAL: deployment is healthy but the pre-deploy snapshot could not be deleted: $rollback_snapshot" >&2
    exit 7
fi

echo "Deployment failed readiness; restoring previous image" >&2
systemctl status "$service" --no-pager >&2 || true
journalctl -u "$service" -n 100 --no-pager >&2 || true

restore_database() {
    if [ -z "$rollback_snapshot" ]; then
        if [ "$database_existed" = false ]; then
            # Roll back to the pre-deploy absence of a database. The path was
            # constrained to /var/lib/openfront-idle/*.sqlite above.
            rm -f -- "$db_path" "${db_path}-wal" "${db_path}-shm" || return 1
        fi
        return 0
    fi
    restore_tmp=$(mktemp "${db_path}.rollback.XXXXXXXX") || return 1
    install -m 0600 -o 65532 -g 65532 "$rollback_snapshot" "$restore_tmp" || return 1
    # The path was constrained to /var/lib/openfront-idle/*.sqlite above.
    # Stale frames from the failed image must never be paired with the restored
    # main database.
    rm -f -- "${db_path}-wal" "${db_path}-shm" || return 1
    mv -f -- "$restore_tmp" "$db_path" || return 1
    restore_tmp=
    restored_integrity=$(sqlite3 "$db_path" "PRAGMA integrity_check;") || return 1
    [ "$restored_integrity" = "ok" ] || return 1
}

if printf '%s\n' "$old_image" | grep -Eq '^ghcr\.io/[a-z0-9._-]+/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$' \
    && [ "${old_image%@sha256:*}" = "$allowed_repository" ]; then
    if ! stop_authority; then
        echo "CRITICAL: refusing database rollback because the authority could not be confirmed stopped" >&2
    elif ! write_image "$old_image"; then
        echo "CRITICAL: could not restore previous image configuration" >&2
    elif ! restore_database; then
        echo "CRITICAL: could not restore the pre-deploy database snapshot" >&2
    elif restart_and_wait; then
        echo "Rollback healthy: $old_image" >&2
        if ! discard_rollback_snapshot; then
            echo "CRITICAL: rollback is healthy but the recovery snapshot could not be deleted: $rollback_snapshot" >&2
        fi
    else
        echo "CRITICAL: rollback failed readiness: $old_image" >&2
        journalctl -u "$service" -n 100 --no-pager >&2 || true
    fi
else
    if ! stop_authority; then
        echo "CRITICAL: no previous image and the authority could not be confirmed stopped; database was not touched" >&2
    elif restore_database; then
        echo "No valid previous digest was available; restored the pre-deploy database and left the service stopped" >&2
    else
        echo "CRITICAL: no previous image and the pre-deploy database restore failed" >&2
    fi
fi

if [ -n "$rollback_snapshot" ]; then
    echo "Recovery snapshot retained at $rollback_snapshot; remove it after recovery is verified" >&2
fi

exit 4
