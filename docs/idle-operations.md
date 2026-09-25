# Idle demo operations runbook

This runbook turns the accepted single-VM design into a reproducible first
deployment. It intentionally uses its own image, environment, service, and
GitHub workflow instead of OpenFront's upstream-only deployment assumptions.

## Topology

```text
iOS / desktop browser
        |
        v
Cloudflare edge (TLS, DNS, optional Access for admin tools)
        |
        v  outbound named Tunnel; no inbound VM port
cloudflared on one Debian VM
        |
        v
127.0.0.1:3000 -> openfront-idle container -> Node authority
                                             |
                                             v
                         /var/lib/openfront-idle/idle.sqlite
                         (idle + persistent-world tables)
                                             |
                                             v
                               online SQLite snapshot -> encrypted
                               restic repository off the VM
```

This follows the useful `sightings.today` shape—single Debian/Proxmox VM,
loopback application, Cloudflare Tunnel, and systemd—while adding versioned
migrations and verified encrypted off-host backups. Cloudflare is the sole
public ingress. Do not expose ports 3000, 3001, or 3002 through the hypervisor,
router, cloud firewall, or host firewall.

## Host baseline

Recommended first-demo VM:

- Debian stable, 2 vCPU, 4 GiB RAM, and 40 GiB SSD-backed storage;
- Docker Engine, `cloudflared`, `sqlite3`, `restic`, `curl`, and `flock`
  installed from trusted package repositories;
- automatic security updates and NTP enabled;
- SSH restricted to keys and a management network or Cloudflare Access;
- `/var/lib/openfront-idle` on storage included in VM-level recovery, but not
  treated as the only backup.

Provision the application directories once:

```sh
sudo install -d -m 0750 -o 65532 -g 65532 /var/lib/openfront-idle
sudo install -d -m 0750 -o root -g root /etc/openfront-idle
sudo install -d -m 0700 -o root -g root /var/backups/openfront-idle
sudo install -m 0600 deploy/idle/openfront-idle.env.example \
  /etc/openfront-idle/openfront-idle.env
sudoedit /etc/openfront-idle/openfront-idle.env
sudo install -m 0644 deploy/idle/openfront-idle.service \
  /etc/systemd/system/openfront-idle.service
sudo install -m 0755 deploy/idle/deploy.sh \
  /usr/local/sbin/openfront-idle-deploy
sudo docker network create --driver bridge \
  --subnet 172.30.0.0/24 --gateway 172.30.0.1 openfront-idle
sudo systemctl daemon-reload
sudo systemctl enable openfront-idle.service
```

If `172.30.0.0/24` overlaps the host network, choose another unused private
/24 and update both the Docker gateway and `IDLE_TRUSTED_PROXY_ADDRESS`; never
broaden trust to the whole subnet.

Use an immutable `ghcr.io/...@sha256:...` image in the environment file. If
the GHCR package is private, authenticate the host's root Docker client once
with a read-only package token. Never put a package token in the unit file.

The container is read-only, has no Linux capabilities, runs as UID/GID 65532,
and receives one writable bind mount for the database. The published port is
hard-bound to IPv4 loopback.

## Cloudflare Tunnel

Create a named tunnel and DNS route in the project's own Cloudflare account.
Copy `deploy/idle/cloudflared-config.yml.example` to
`/etc/cloudflared/config.yml`, replace the placeholders, and keep the tunnel
credentials root-readable only.

Validate before enabling it:

```sh
sudo cloudflared tunnel ingress validate
sudo systemctl enable --now cloudflared
sudo ss -lntp | grep 127.0.0.1:3000
```

WebSockets work through the same HTTP service; no public nginx listener or
port-forward is needed. The authority trusts forwarded client addresses only
from loopback in local development or the single configured `172.30.0.1`
gateway of its isolated Docker bridge, matching the
`cloudflared -> 127.0.0.1:3000 -> container` route. It does not trust the bridge
CIDR. Any future intermediate proxy requires an explicit trust-boundary
review. Keep `/api/idle/admin/*` disabled on the player origin. A future admin
UI should use a separate Cloudflare Access-protected hostname and server-side
authorization, not merely a hidden URL.

## Runtime configuration

`deploy/idle/openfront-idle.env.example` contains non-secret development-safe
defaults and the complete initial variable list. Production requirements:

- `IDLE_IMAGE_REPOSITORY` is this fork's exact lowercase GHCR repository;
- `IDLE_IMAGE` is an immutable digest from that repository;
- `GAME_ENV=prod` and `IDLE_ADMIN_ENABLED=false`;
- `IDLE_TELEMETRY_HMAC_SECRET` is a random secret of at least 32 characters,
  stored outside SQLite;
- `IDLE_DB_PATH` remains under `/var/lib/openfront-idle`, and
  `PERSISTENT_WORLD_DB_PATH` points at the same file. Persistent-world tables
  and migrations are namespaced, while one file keeps deployment rollback and
  encrypted off-host backups atomic across both services;
- `IDLE_DEPLOY_DRAIN_STATUS_PATH` remains the supplied path under
  `/var/lib/openfront-idle`, and `IDLE_DEPLOY_DRAIN_TIMEOUT_SECONDS` is the
  maximum wait for ordinary in-progress matches (two hours by default);
- `IDLE_TRUSTED_PROXY_ADDRESS=172.30.0.1` matches the dedicated Docker bridge
  gateway created above;
- `DOMAIN` matches the public audience used for future login tokens;
- recovery codes and future OAuth credentials are hashed/encrypted as
  appropriate and never logged;
- the environment file is mode `0600`.

The first demo has one worker because SQLite has one authority writer. Do not
raise `NUM_WORKERS` until idle routing and ownership are deliberately split or
the authority is moved to Postgres.

## CI, image publication, and deployment

`.github/workflows/idle-ci.yml` is fork-owned and has two paths:

1. Every pull request/push installs with Node 24 and
   `npm ci --ignore-scripts`, then type-checks, builds, tests, lints, checks
   formatting, launches the built server, and exercises the idle API smoke
   contract including idempotency and restart recovery.
2. A manual dispatch from the protected default branch can publish a
   commit-addressed image to this repository's GHCR namespace, after approval
   through the selected `idle-staging` or `idle-production` environment.

This fork is public, so the workflow deliberately does **not** attach a
persistent self-hosted runner to the Proxmox management network. A pull-request
workflow in a public repository must never be given a durable foothold on that
network. Until the hosting planning phase chooses and verifies a noninteractive
Cloudflare Access/WireGuard path (or an organization-owned, ephemeral runner
group restricted to the exact deployment workflow), deployment is a manual
management-network operation using the root-owned wrapper installed above.

The built-in `GITHUB_TOKEN` publishes to GHCR. The VM must already be
bootstrapped with Docker, the service/environment files, and (for a private
package) a read-only GHCR login. Do not copy OpenFront application keys,
domains, SSH secrets, app tokens, or CDN settings into this fork.

If remote automation is approved later, its deploy user's only passwordless
privilege should be the validated wrapper, for example (adjust the dedicated
username as needed):

```text
openfront-deploy ALL=(root) NOPASSWD: /usr/local/sbin/openfront-idle-deploy
```

The wrapper rejects any digest outside `IDLE_IMAGE_REPOSITORY`. Such a future
deployment identity must disable shell, TTY, agent, and port forwarding, or
use an SSH forced command that invokes only this wrapper. Environment approval
and the private network path are additional controls, not substitutes for this
restriction.

Copy the exact digest from the approved publish job, connect through the
management path, and invoke:

```sh
sudo /usr/local/sbin/openfront-idle-deploy \
  ghcr.io/OWNER/REPOSITORY@sha256:PUBLISHED_DIGEST
```

The root-owned deploy script validates the repository and immutable image
reference, serializes host mutations with `flock`, and pulls the image before
changing live state. It then signals the current authority to enter deployment
drain. Workers stop matchmaking and new lobby admission, close unstarted
ordinary lobbies, and report their state through an atomically replaced file
on the existing bind mount. Already assigned matches are honored. The wrapper
waits until every worker reports no ordinary in-progress game; journaled
managed worlds do not block because restart recovery is part of their contract.
If the bounded drain deadline expires, the wrapper cancels the deployment,
signals workers to reopen admission, and leaves the current image running.

Once drain is ready, the wrapper briefly stops the single writer, creates and
integrity-checks a root-only pre-deploy SQLite snapshot, atomically changes only
`IDLE_IMAGE`, restarts the named service, and polls loopback health. If readiness
fails, it restores both the previous image and its matching database snapshot
before verifying rollback health. This schema-coupled rollback is required
because an older executable may intentionally reject a newer schema. The
candidate container cannot access `/var/backups/openfront-idle`. The wrapper
deletes its temporary snapshot only after a healthy new deployment or healthy
rollback; on any restore/stop failure it leaves the root-only artifact in place
and prints the exact recovery path.

Persistent matches treat this restart as a normal recovery boundary. The
master first closes public ingress, signals every gameplay worker to flush its
final managed-turn batch through IPC, and waits up to 15 seconds before it
exits. The bind-mounted SQLite database retains the frozen roster, stable game
identifier, configuration, and contiguous turn journal. On startup the master
recreates every active managed game from that journal, after which clients
reconnect through the same canonical `/wN` route. Simulation time is paused
during the short deployment outage; it is not advanced from wall-clock time.

Full-journal replay is suitable for the one-day playtest phase. Before week-long
production worlds, add periodic hashed engine checkpoints plus acknowledged
worker-to-master journal delivery so recovery work and the possible unconfirmed
tail remain bounded regardless of world age.

For a schema-compatible release, manual rollback is the same operation with an
older known-good digest:

```sh
sudo /usr/local/sbin/openfront-idle-deploy \
  ghcr.io/OWNER/REPOSITORY@sha256:KNOWN_GOOD_DIGEST
```

After a successful schema-changing release, do not assume an arbitrary older
image can read the current database. Use a matching verified database backup
and the incident restore sequence below, explicitly accepting any state lost
after that recovery point. Every migration must exercise the immediate failed-
readiness rollback drill before production approval.

## Backups and restore drills

SQLite WAL files must not be copied independently while the database is live.
`deploy/idle/backup.sh` uses SQLite's online backup command, runs an integrity
check on the snapshot, then sends it to restic. Restic encrypts before writing
to the off-host repository.

Install the backup files and create `/etc/openfront-idle/backup.env` from its
example. Store the restic password in a separate root-only password file.
Initialize the dedicated repository exactly once before enabling the timer:

```sh
sudo sh -c 'set -a; . /etc/openfront-idle/backup.env; restic init'
```

```sh
sudo install -m 0755 deploy/idle/backup.sh \
  /usr/local/sbin/openfront-idle-backup
sudo install -m 0644 deploy/idle/openfront-idle-backup.service \
  /etc/systemd/system/openfront-idle-backup.service
sudo install -m 0644 deploy/idle/openfront-idle-backup.timer \
  /etc/systemd/system/openfront-idle-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now openfront-idle-backup.timer
sudo systemctl start openfront-idle-backup.service
sudo journalctl -u openfront-idle-backup.service -n 100 --no-pager
```

Each backup verifies SQLite integrity, uploads an encrypted online snapshot,
runs `restic forget --keep-within 14d --prune`, and performs `restic check`
under a two-hour systemd runtime ceiling. The live authority independently
secure-deletes raw tap rows after 14 days, then truncates the WAL so the online
backup cannot recopy expired frames or freelist payloads. Together those
windows keep scheduled recovery copies under the disclosed 30-day raw-event
ceiling. Keep this a
dedicated repository so its bounded privacy policy cannot prune unrelated
backups. Alert if the timer misses 30 hours: restic intentionally preserves a
latest snapshot when maintenance stops, so decommissioning must delete the
dedicated repository and destroy its credentials rather than merely disabling
the timer.

At least monthly, restore the latest snapshot into an isolated directory and
verify it before launching a disposable authority:

```sh
sudo sh -c '
  set -a
  . /etc/openfront-idle/backup.env
  drill=$(mktemp -d /var/lib/openfront-idle/restore-drill.XXXXXX)
  restic restore latest --target "$drill"
  sqlite3 "$drill/openfront-idle/idle.sqlite" "PRAGMA integrity_check;"
  printf "restore drill staged at %s\n" "$drill"
'
```

Run session/state/tap smoke against a disposable process using that restored
file, then remove the explicitly printed drill directory. A backup is not
healthy until a restore drill succeeds.

## Observability and alerts

Monitor at minimum:

- `/api/idle/health` availability and process restarts;
- SQLite transaction latency, busy/locked errors, WAL size, and free disk;
- accepted, rejected, duplicate, reward-capped, and quarantined tap counts;
- state-revision lag and session recovery failures;
- raw observation deletion lag against the 14-day live policy;
- last successful off-host backup and restore-drill age.

Never put recovery codes, full source addresses, auth headers, raw tap payloads,
or exact behavior sequences in general logs. Administrators access raw
observations only through an audited, access-controlled path.

Suggested initial alerts are five minutes of failed health checks, free disk
below 20%, no successful backup for 30 hours, any integrity-check failure, and
a sustained SQLite p95 write time above 25 ms. The Postgres migration triggers
are recorded in `docs/idle-architecture.md`.

## Incident sequence

1. Preserve logs, the current image digest, database/WAL files, and relevant
   Cloudflare events without publishing player data.
2. If writes may corrupt state, stop `openfront-idle` while leaving the tunnel
   on a maintenance response.
3. Restore into a new file; never overwrite the only copy of the damaged
   database.
4. Run integrity and smoke checks against loopback.
5. Point both `IDLE_DB_PATH` and `PERSISTENT_WORLD_DB_PATH` at the verified
   restore, restart, and monitor.
6. Record affected revisions and anti-cheat ruleset versions so enforcement
   can be reversed if necessary.

## Public-launch gate

Before accepting real persistent players:

- replace OpenFront marks and all excluded proprietary/external assets;
- publish required AGPL corresponding source and CC BY-SA attribution;
- add a reviewed privacy notice, telemetry deletion job, and player data
  request path;
- replace recovery-code-only identity with reviewed Discord linking and an
  account recovery policy;
- protect admin operations with real authentication and Cloudflare Access;
- complete a restore drill, rollback drill, load test, and iOS Safari/Firefox
  smoke test on the public hostname.
