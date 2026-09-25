# ADR-001: Authoritative idle-world foundation

- Status: Accepted for the first playable demo
- Date: 2026-08-14
- Decision owners: project owner and implementation team
- Supersedes: none

## Context

OpenFront provides a useful TypeScript client, deterministic simulation, lobby,
and WebSocket transport, but its current game state is simulated by every
client and its complete turn history lives in worker memory. That is not a
durable authority boundary for an idle game. A disconnected player must keep
their progress, a returning device must receive one canonical state, and an
attacker must not be able to mint rewards by changing a clock or replaying a
request.

The first game mode uses these accepted product defaults:

- 8–16 players share a seven-day seasonal world.
- Players make 2–4 short visits per day. Passive progress is meaningful after
  4–8 hours and is capped at 24 hours offline.
- Supply accrues passively. Active pressure taps produce capped Influence.
  Both fund production, automation, and defensive upgrades.
- Tapping another player's territory is visible and scoreable but nonlethal.
  It cannot take territory, reduce the defender's stored resources, or remove
  an AFK player.
- Defenders see live heat/ripples and a return summary such as “87 pressure
  taps from a teammate.” Raw tap-by-tap data is not exposed to other players.
- A guest can begin immediately and later link Discord for cross-device
  persistence. Only one device holds the command lease; other devices are
  read-only until control is deliberately transferred.

## Decision

### 1. The server owns every consequential transition

The server is authoritative for the world clock, passive accrual, command
eligibility, Influence rewards, pressure, decay, upgrades, summaries, and
season scoring. The browser renders the latest known state and may animate an
optimistic tap, but a client prediction never changes durable game state.

The demo HTTP contract is intentionally small:

- `POST /api/idle/session` creates or recovers a player session.
- `GET /api/idle/state` returns canonical state for a player; the opaque
  session credential travels in an `Authorization` header, never the URL.
- `POST /api/idle/tap` submits a pressure command with a monotonically
  increasing client sequence.
- `GET /api/idle/admin/summary` exposes aggregate development diagnostics only
  when explicitly enabled and protected by a separate bearer token. It is not
  a production player endpoint.

Every state-changing command carries a protocol version, authenticated player
and device/session identity, monotonically increasing client sequence, and a
server receipt time. Client wall-clock time is never used to calculate
progress or rewards. `clientMonoMs`, pointer type, page visibility, and
quantized normalized coordinates are behavioral signals, not authority.

A tap is handled in two durable phases:

1. Authenticate the session and apply hard transport ceilings.
2. Append a minimized raw receipt observation before gameplay evaluation.
   This makes a server failure visible as a `pending` receipt rather than
   silently losing an authenticated attempt.
3. Validate protocol version, territory, coordinate bounds, sequence, and
   season status.
4. In one logical-command transaction, insert the command under a unique
   `(session_id, client_seq)`
   constraint. If it already exists, return the stored outcome without
   granting Influence or pressure a second time.
5. Apply deterministic rate/reward caps and the current enforcement policy.
6. Update pressure, Influence, summaries, and the monotonically increasing
   world revision, then link/finalize the receipt.
7. Commit the logical outcome before acknowledging success.

Transport retries are therefore safe. A duplicate request can be observed for
abuse analysis while its logical command remains exactly-once. Each offline
queue entry retains the session lease that created it, so recovery never
silently re-keys an uncertain command. The client drains queued human taps at
135 ms or slower; a normal reconnect burst therefore stays below the initial
eight-rewards-per-second budget instead of losing legitimate Influence.

### 2. SQLite WAL is the first durable authority

The first hosted world uses one Node authority process and one SQLite database
on durable VM storage. SQLite runs in WAL mode with `synchronous=FULL`,
`secure_delete=ON`, `foreign_keys=ON`, a busy timeout, and versioned,
transactional migrations. Retention sweeps truncate-checkpoint the WAL, and a
one-time vacuum removes freelist remnants from databases created before secure
deletion. There is only one writable authority; background analysis must not
become a second writer.

The first playable schema separates:

- player identity and recovery/link records;
- device sessions and the active command lease;
- worlds, rolling seven-day season windows, territories, and balances;
- raw logical commands and observations, a constant-size sequence watermark
  per session, and a decaying player risk score;
- defender activity summaries derived from retained logical taps;
- schema version and world revision.

The demo's compact canonical state is already a bounded SQLite snapshot.
Before worlds grow beyond this compact representation, the authority will
periodically persist a versioned materialized snapshot and append accepted
events with increasing revisions. A reconnecting client will receive either a
current snapshot or a snapshot plus events after its known revision. This is
the target replacement for an unbounded in-memory `turns.slice(lastTurn)`
history.

For the first demo, `GET /api/idle/state` returns a complete compact
snapshot. The revision and schema version are still required so delta sync can
be added without replacing the authority contract.

### 3. AFK pressure is visible but cannot destroy

Pressure is a separate mechanic, not an OpenFront attack. It affects attacker
activity score and a decaying visual heat value. It may produce capped active
Influence, but it never transfers territory, drains the defender, stops the
defender's passive production, or eliminates a player.

Pressure heat decays on server time. Defender notifications are aggregated by
attacker and time bucket to keep a return summary useful instead of turning
spam into harassment. Automation and defenses can modify reward efficiency,
decay, or summary presentation, but they cannot create an offline-death path.

### 4. Tap collection is minimized, disclosed, and access-controlled

Exact interaction timing can be sensitive behavioral data. The game must
plainly disclose anti-cheat telemetry in its privacy notice even when scoring
and enforcement thresholds remain undisclosed.

Raw observations may contain:

- server receipt timestamp and request identifier;
- pseudonymous player, device-session, world, and target identifiers;
- client sequence, client monotonic time, pointer category, visibility state,
  and coarse/quantized normalized coordinates;
- validation, idempotency, reward, rate-limit, and policy outcomes;
- a rotating-key HMAC of the source network address and a coarse user-agent
  family, when necessary for abuse investigation.

Do not collect raw pointer paths, device fingerprints, unrelated browser
properties, precise IP addresses in gameplay tables, or hidden third-party
tracking identifiers. Application logs must not duplicate the full raw event.
The receipt guarantee is deliberately precise: every schema-valid,
authenticated attempt beneath the documented 40/second and 600/minute hard
transport ceilings is observed. Malformed or ceiling-exceeding traffic is a
transport/security event, not a gameplay tap. The network HMAC secret lives
outside SQLite in production so a database copy alone cannot reverse small IP
spaces.

Retention defaults:

| Data                            |         Default retention | Purpose                                 |
| ------------------------------- | ------------------------: | --------------------------------------- |
| Live raw tap observations       |                   14 days | Replay, automation, and incident review |
| Encrypted recovery copies       |                   14 days | Disaster recovery                       |
| Per-session sequence watermark  |  Session/account lifetime | Prevent replayed command rewards        |
| Derived risk decisions/features | 90-day hosted-beta target | Appeals and repeat-pattern review       |
| Defender activity summaries     |                   14 days | Player-visible summaries                |
| Economy/world state             |    Account/world lifetime | Core game operation                     |
| Operational logs                |           Bounded by size | Reliability and security diagnosis      |

The playable schema enforces raw tap expiry with an indexed hourly sweep,
secure deletion, and a truncated WAL while retaining one highest-sequence
integer per session. An unreferenced internal maintenance poll runs even
without player traffic; a busy WAL checkpoint leaves the API available and is
retried after one minute before the sweep is marked successful. Within the live
raw window, a retry receives its exact
stored result; after expiry, an older sequence is reported as an expired replay
with zero reward. This watermark contains no target, timing, pointer, network,
device, or per-command outcome history and therefore stays constant-size even
under sustained input. The live and encrypted-copy windows keep normally
scheduled recovery copies below the accepted 30-day raw-event ceiling. The
schema uses a reversible, time-decaying player risk score. A separate versioned
risk decision/case table and its 90-day deletion job remain a hosted-beta
launch gate; the runtime does not advertise an unenforced risk-retention
setting.

Before public accounts are enabled, deletion requests must remove or
irreversibly anonymize player-linked telemetry unless a documented legal or
active-security hold applies. Raw access is restricted to a separately
authenticated administrator endpoint and must move behind a Cloudflare
Access-protected hostname before hosting.

### 5. Anti-cheat uses a reversible enforcement ladder

The first engine calculates server/client-correlated rate, interval regularity,
sequence, active-command-session, and replay signals. Client timing is scoped
to one session so an offline queue, reload, or device transfer does not inherit
another clock epoch. Risk decays on server time and quarantine reverses below
its threshold. Coordinate/visibility models, calibrated feature versions, and
case evidence are hosted-beta work. A single autoclick-like pattern is not
proof; accessibility software, high-skill play, latency, and retries can look
similar.

Enforcement escalates in reversible stages:

1. Reject structurally invalid or impossible commands.
2. Apply the same documented gameplay reward cap to everyone.
3. Silently increase risk score and observation for suspicious patterns.
4. Remove rewards for the suspect commands or apply a temporary shadow
   cooldown while preserving the defender's safety.
5. Quarantine the command session and notify administrators with evidence.
6. Require human review for account-wide or permanent removal.

Before permanent or account-wide actions exist, every enforcement decision
must record its ruleset version, features, outcome, expiry, and reviewer.
Thresholds and raw behavioral data are never shipped to the client.

### 6. Postgres migration has explicit triggers

SQLite is not a promise to remain single-node forever. Begin a Postgres
migration when the first of these occurs:

- more than one authoritative application process must write concurrently;
- sustained write load exceeds 100 transactions/second or p95 write
  transaction time exceeds 25 ms for 15 minutes under normal load;
- the database exceeds 20 GiB or an online backup routinely exceeds 15
  minutes;
- zero-downtime failover, read replicas, multi-region authority, or concurrent
  analytical queries become product requirements;
- WAL/checkpoint contention consumes more than 5% of requests in a seven-day
  observation window.

Repository interfaces keep transaction semantics explicit so the database can
change without moving authority into clients. Redis may later cache disposable
views or coordinate jobs, but it is never the source of truth for balances,
commands, sessions, or enforcement.

### 7. The derivative has a strict licensing boundary

The current codebase is AGPL-3.0 with additional attribution terms. A network
deployment must provide the corresponding modified source and preserve the
required notices; release automation must identify the exact source revision.
This is an engineering boundary, not legal advice.

Assets under `resources/` are CC BY-SA 4.0 and require attribution/share-alike
compliance. Files under `proprietary/`, OpenFront CDN assets, its closed
Cloudflare Worker, trademarks, and service credentials are excluded from the
idle deployment image. The distributable game needs original branding and
replacement art. CI/container builds for this fork must not copy
`proprietary/`.

Before a public launch, an owner must complete an asset inventory and legal
review. The prototype may exercise openly licensed assets only with required
attribution.

## Consequences

- Disconnects, retries, and device changes have one durable result.
- The demo can ship cheaply on one VM, but horizontal writes are deliberately
  deferred.
- Persisting every receipt creates storage and privacy obligations; bounded
  retention, aggregation, and deletion are part of the feature rather than
  later cleanup.
- Optimistic client animation must reconcile against server responses.
- Existing OpenFront attack and client-authoritative execution paths cannot be
  reused for the idle economy without an authority adapter.
- The open-source and asset-compliance path is visible before branding or
  deployment work becomes expensive.

## Playable-milestone boundaries

This commit is a vertical demo slice, not the completed game economy:

- one compact 12-territory world starts with eight bots; up to twelve human
  guests replace them, satisfying the first small-session target;
- an expired seven-day window rolls forward lazily so the demo never becomes
  permanently dead, while scoring, archival, reset rewards, and multi-world
  matchmaking remain part of the pacing-planning phase;
- Supply accrual, Influence, pressure, command leases, recovery, raw expiry,
  and admin aggregates are live; upgrades, production spending, automation,
  Discord linking, and a dedicated admin case UI are not;
- guest recovery credentials in local storage are acceptable for the LAN
  prototype only. Public cross-device identity requires the planned OAuth
  exchange and secure session design.

## Rejected alternatives

- **Client-authoritative idle progress:** trivial to alter clocks, balances,
  and tap rewards; incompatible with cross-device continuity.
- **Unbounded deterministic replay only:** restart time and storage grow with
  every season; snapshots are still required.
- **Lethal pressure while AFK:** contradicts the accepted safety and return
  experience.
- **Redis as authority:** durability and recovery semantics are a poor fit for
  balances and exactly-once commands.
- **Managed multi-node infrastructure immediately:** adds cost and coordination
  before load justifies it; the repository boundary preserves a migration path.

## Validation requirements

CI and release candidates must verify:

- the app shell and at least one generated asset are served successfully;
- a session can be created and its state fetched;
- a valid pressure tap changes the expected authoritative state;
- replaying the same client sequence does not double-apply reward or pressure;
- development admin aggregates observe the request;
- state survives an authority restart against the same database file;
- the deployment image contains no `proprietary/` path.
