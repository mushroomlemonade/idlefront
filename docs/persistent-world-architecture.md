# Persistent OpenFront worlds

Status: accepted product and architecture direction, September 2026.

## Current milestone freeze

The current milestone builds the complete application around the game before
any pacing or core-structure change lands. It includes identity, world setup,
invitations, durable lobbies, RSVP and presence, quick chat, reminders, public
discovery, teams, spectating, archives, mobile/web continuity, operations, and
pacing telemetry.

The pacing decisions later in this document remain accepted requirements, but
they are deliberately deferred until that application structure can run real
playtests. During this milestone, do not change building availability or cost,
troop/population/gold rates, conquest speed, alliances, betrayal penalties,
immunity, AI cadence, land-front limits, caretaker behavior, victory logic, or
the deterministic simulation. Instrument current behavior; do not tune it.

## Product boundary

Pressure Atlas persistent worlds are OpenFront matches with durable social and
server lifecycle infrastructure. They are not a second idle-game simulation.
The existing map renderer, territory model, population and troop economy,
building effects and prices, defense posts, ports, factories, rail networks,
weapons, diplomacy, terrain, and 80% land victory remain the game.

Persistent-world work may change when and for how long those systems operate.
It must not silently replace what they do. Ordinary short OpenFront matches
must continue to use their existing lifecycle and balance.

The latest released OpenFront ruleset is the canonical "laws of physics" for
IdleFront. This fork must stay structurally capable of taking upstream rules,
AI, map, renderer, and balance updates. Persistent-world code therefore lives
at explicit application and runtime-adapter boundaries instead of copying or
forking those rules into a parallel implementation. Any intentional deviation
must be versioned, playtest-visible, and approved as a pacing profile; silent
drift from upstream is a defect.

The first duration profiles are one hour, one day, and seven days. The selected
duration is a pacing target, not a forced ending; normal OpenFront victory ends
the world. Profiles are released sequentially: one hour first, then one day,
then seven days after the preceding profile has credible playtest telemetry.

## Lobby contract

- A world begins as a durable invitation card with a server-owned start time,
  countdown, quick-chat history, and a roster that keeps RSVPs visible while
  they are offline.
- Hosts choose a named start preset (20 minutes, tomorrow, seven days, or
  fourteen days) or an exact time. Once a non-host RSVPs, changing the time is
  forbidden; the host may cancel and create a replacement invitation.
- Worlds start automatically at the promised time even when nobody is online.
  Missing seats are filled by the existing full AI Nations.
- Humans may participate with an account, a verified email-only contact, or a
  device-bound guest identity. Registration and email are encouraged but are
  not admission requirements for private or public worlds.
- Pre-start quick chat uses the existing curated phrase vocabulary. Free-text
  lobby chat is out of scope for the first release.
- Public worlds accept new RSVPs only before start. A private host may invite a
  new player after start. An eligible late player may choose a surviving full
  AI Nation during the first third of the target duration. A seat is not
  guaranteed; if no eligible Nation survives, the player may spectate.
- Persistent worlds support FFA with normal alliances and team games. Team
  players choose their team in the lobby. Human capacity is 2-16.
- Public worlds are live-spectatable. Private worlds require their invitation
  capability. Completed summaries and full gameplay replays are retained.

The notification transport for the first release is email plus in-app state,
not mobile push. A player with a verified email receives the start notice and
may opt into three pre-start choices inferred from invitation lifetime. For an
invitation lifetime `L`, the initial candidates are `L/7`, `L/28`, and
`L/224`, rounded to friendly units, clamped to at least 30 seconds, and
deduplicated. This produces two days, twelve hours, and ninety minutes for a
fourteen-day invitation.

## Runtime authority and durability

The current server stores lobbies and turns in memory and relies on connected
clients to run the deterministic simulation. That is insufficient: it ends an
unattended match, loses worlds on process restart, and cannot safely decide
whether a submitted command is valid.

Persistent worlds introduce a server-owned headless instance of the same
deterministic core. The server is authoritative for ticks, accepted intents,
AI, victory, and recovery. Clients continue to render the existing map and may
calculate diagnostic hashes, but client consensus is no longer the source of
truth for persistent worlds.

Each accepted intent is idempotent and durably journaled before application.
A versioned, checksummed simulation checkpoint records all deterministic state,
including the tick, random state, players, territory, structures, units,
executions, alliances, and AI state. On restart the world loads its newest
valid checkpoint, replays the journal, advances missed wall-clock ticks in
headless mode, and only then accepts controllers. A bad newest checkpoint falls
back to the preceding valid generation.

### Catch-up delivery stages

The first playtest implementation remains journal-first. A returning client
receives the exact missing OpenFront turns and applies every deterministic
update. The visible **Skip wait** control switches that replay to a bounded
fast-forward worker mode: historical turns cross the main-thread boundary in
batches, and the simulation runs a larger batch for up to 12 ms before each
yield. This removes avoidable browser task overhead without changing game
rules, discarding updates, or freezing the page indefinitely.

That fast path is an accelerator, not the week-world solution. Replay cost is
still linear in world age, so a sufficiently old world can still take minutes
or hours. Before seven-day playtests, implement versioned simulation
checkpoints with these invariants:

1. A checkpoint contains the complete deterministic engine state and the last
   committed turn; visual/UI state is never authoritative.
2. The worker hashes and writes a new generation in the background, then the
   master atomically records it only after durable storage acknowledges it.
3. Join sends the newest compatible checkpoint plus the journal suffix. An
   incompatible or corrupt checkpoint falls back to the previous generation,
   then ultimately to turn zero.
4. Keep at least two generations, cap the journal suffix by both elapsed time
   and turn count, and exercise recovery across an ordinary four-hour deploy.
5. A client never supplies an authoritative checkpoint. Client hashes may
   audit the server-owned result but cannot choose or mutate it.

Durable elimination labels use the current consensus live-stat path as an
intermediate measure. Once any in-sync client reports an agreed death, it is
stored against the RSVP seat and is sticky on the world card. Detecting an
elimination before the first client returns from a wholly unattended interval
requires the same authoritative headless simulation/checkpoint work above.

The first `idlefront.io` host follows the proven sightings.today shape:

- one Debian VM on the private Proxmox host;
- Node services bound to loopback and supervised by systemd;
- Cloudflare Tunnel as the only public ingress;
- SQLite WAL as the system of record for world metadata, memberships, chat,
  reminders, intent journals, and checkpoint indexes;
- compressed checkpoint/replay blobs on durable local storage with hashes and
  encrypted, restore-tested off-host backups;
- Redis, when present, only for disposable presence, fan-out, leases, and rate
  limits; and
- PostgreSQL before multi-host or active/active world execution.

Public ingress is through Cloudflare Tunnel to the Debian 13 host. The Node
services remain loopback-bound; the tunnel is not permission to expose worker,
database, administration, or observability ports directly. `idlefront.io` and
`www.idlefront.io` are the production web identities. Preview and production
hostnames must use separate tunnel credentials, service units, databases, and
backup scopes.

## Upstream compatibility contract

The repository keeps `upstream` pointed at the official OpenFront repository
and treats upstream integration as a repeatable release operation:

1. fetch and record the upstream commit and release being evaluated;
2. merge it on a dedicated integration branch without rewriting this
   repository's published history;
3. run ordinary OpenFront typecheck, lint, deterministic-core, replay,
   matchmaking, client, and server regressions unchanged;
4. run IdleFront application-boundary tests proving the map renderer, ordinary
   match lifecycle, structures, and balance were not shadowed;
5. smoke-test persistent invitation and return flows against that engine; and
6. promote only after recording intentional conflicts and migration impact.

No automated job may merge an upstream change directly to `main`. Automation
may open or refresh the integration branch and produce the compatibility
report; a human approves the resulting physics update.

Exactly one runtime lease owns a world. A second process may recover it only
after the first lease expires or is explicitly released. The lease never makes
Redis authoritative.

## Pacing invariants

There is no player class, technology tree, daily energy, explicit bot phase,
hard nation phase, or defeat grace in the first persistent release. Buildings
become available through their unchanged affordability. The familiar bot,
Nation, and human phases remain emergent.

Moment-to-moment controls and feedback stay immediate. Duration profiles may
scale macro rates such as population/gold/trade accrual, Nation decision
cadence, conquest progression, alliance lifetime, the existing betrayal
defense penalty, and existing immunity. Relative structure costs/effects,
defensive calculations, factory/rail behavior, and weapon behavior stay
frozen until a separately approved balance phase.

Bots remain unrestricted expansion targets. A player may maintain attacks
against at most three distinct Nations or human players at once; multiple
orders against the same sovereign share one land front. This does not change
the existing three-boat limit. Alliances keep current OpenFront behavior:
players may break immediately, while alliance duration and the existing
betrayal penalty scale with the world profile.

An offline human keeps normal passive production and automatic game defenses.
The conservative caretaker may close unsafe outgoing attacks to preserve the
normal reserve target, but it never opens a front, expands, constructs,
negotiates, or spends on the player's behalf. It provides no immunity and
cannot prevent elimination.

Pacing profiles are immutable after a world is created. Owner-only development
tools edit and version the next world's profile; they never mutate a live
playtest.

## Observation and safety

All map taps, including selections and cancelled map gestures, may be retained
for anti-automation analysis. Ordinary non-map interface taps are not retained.
Raw tap events expire after 30 days and compact derived risk after 90 days.
Network identifiers are keyed pseudonyms, user agents are coarsened, and public
replays exclude private identity, contact, network, and risk data.

The watchdog may automatically reject excess commands, throttle rewards/input,
or quarantine a controller while notifying administrators. Permanent account
or world sanctions require review against the durable evidence and audit log.
Collection and retention must be disclosed even though detection is not
announced during play.

## Delivery gates

The durable lobby and identity lifecycle lands before simulation pacing. The
one-hour profile then proves automatic start, zero-client continuation,
restart recovery, late Nation takeover, reconnect across devices, permanent
replay, and ordinary-match isolation. One-day and seven-day profiles remain
unavailable until load tests and real playtests show recoverable worlds and a
finish distribution near the preceding profile's target.
