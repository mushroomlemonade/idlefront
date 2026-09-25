# Server-authoritative simulation and large-world performance

Status: revised after scale review, September 5, 2026. Feasibility at the
requested massive-world scale remains unproven.

This document records the next performance phase without changing the current
OpenFront rules, map behavior, structures, balance, AI decisions, or pacing
profiles. The latest OpenFront ruleset remains the laws of physics.

## What the current runtime actually does

The server owns a 100 ms turn clock, accepts and stamps intents, stores the
turn journal, and relays each committed turn to connected clients. It does not
execute `GameRunner` or `GameImpl`.

Every browser creates a complete deterministic `GameRunner` in a worker and
replays the complete world, including bots, Nations, structures, combat, and
economy. Clients periodically send state hashes and live-stat snapshots; the
server uses those for desync and status consensus. This is why a slow or
reconnecting client can remain in `catching up` while the server continues to
advance: the backlog is in that browser worker, not in the server clock.

The existing core is already suitable for a headless runtime. The full-game
perf harness constructs the same `Game`, `Executor`, and `GameRunner` in Node,
without a browser, and the deterministic core has no rule-level dependency on
rendering.

## Baseline measured in this checkout

`Expanded Earth`, 2,000 bots plus 107 Nations, after the 302-turn spawn phase:

- 100 simulation ticks: 4,522 ms of simulation time over 4,540 ms wall time
- mean 45.2 ms, p50 49.4 ms, p95 60.8 ms, p99/max 129 ms
- 2 ticks over 100 ms
- peak JavaScript heap approximately 92 MB

These 100 ticks cover only ten seconds after spawn, with three units present at
the end. They do not establish sustained 10 Hz capacity, late-game capacity,
production-host capacity, or performance at ten times the area. The heap figure
excludes separately accounted array-buffer memory and is not process memory.
Capacity must measure both one large world's critical simulation path and the
number of worlds the host can sustain. A slow client must never back-pressure
the clock.

Review follow-up: the same seed and map, 1,800 post-spawn ticks (three simulated
minutes), with all optional profilers disabled, completed in 96.8 seconds.
Mean was 53.8 ms, p50 49.3 ms, p95 75.0 ms, p99 150 ms, maximum 175 ms;
59/1,800 ticks exceeded 100 ms. It ended with 254 units and 1,462 alive players.
Sampled peak JS heap was 253 MB. A mid-run Windows process observation reported
880,615,424 bytes working set and 888,442,880 bytes peak working set at that
instant; these are not a continuously measured final memory peak. This remains
an early-game, no-human-intents test on the development machine, not a week-long
load test or a measurement of the Debian production server.

## Target relationship

```text
player input -> server validates/adopts intent -> authoritative simulation
                                      |                  |
                                      |                  +-> journal/checkpoint
                                      v
                            per-client snapshot/delta stream
                                      |
                              render/interpolate only
```

The server advances fixed simulation ticks on its own schedule. Network sends,
browser rendering, and reconnect replay are separate queues. A client may
receive a delayed or coalesced view, but it cannot delay, rewrite, or select the
authoritative state.

## Staged migration

### 1. Instrument the existing relay path

Add per-match metrics behind the existing debug/telemetry gate:

- tick start/commit time and event-loop drift;
- intent ingress-to-commit latency and rejected-intent counts;
- per-client socket queue depth, bytes, and send duration (deterministic input
  turns cannot be dropped or coalesced; only replaceable view state in the new
  protocol may be coalesced against an acknowledged baseline);
- client-reported worker tick duration, pending-turn depth, and catch-up age;
- replay/join duration, number of turns replayed, and snapshot size.

This separates server CPU, server event-loop pressure, network back-pressure,
structured-clone cost, worker simulation, and renderer cost before we move any
source of truth.

### 2. Add a shadow headless runtime

Create one `HeadlessGameRuntime` adapter around the existing deterministic core.
It should load the same `GameStartInfo`, map manifest, and seed as clients, then
consume the committed turn stream on the server. Initially it only computes
hashes/stats and compares them with the current client consensus. It must be
feature-flagged per managed world and must not affect ordinary matches.

The adapter should be extracted at a boundary that does not import browser HUD
helpers. The core rules remain shared; only view-data generation is optional.

### 3. Make the managed-world runtime authoritative

For one-hour managed playtests, the headless runtime becomes the source of
truth for tick advancement, AI, victory, accepted intents, and recovery. The
server emits authoritative state updates; client hashes become diagnostics only.
Ordinary short OpenFront matches continue using the current deterministic
client mode during this migration.

Use a worker isolated from the network event loop for each active simulation,
subject to measured admission limits. This distributes separate worlds across
cores but does not parallelize one world's serial execution loop. Scaling a
single world requires reducing algorithmic work and selectively parallelizing
tasks with proven independent inputs and deterministic commit order. Spatial
storage pages are not independent simulation shards.

### 4. Checkpoint and bounded catch-up

Persist a versioned, checksummed checkpoint containing complete deterministic
state and the last committed turn. Keep two generations and an append-only
journal. These recovery checkpoints belong to the server. A returning client
receives a separate render-state snapshot for its subscriptions, followed by
versioned deltas; it does not deserialize AI or replay simulation executions.

The current client fast-forward worker remains a legacy compatibility path.
Optional catch-up animation uses a bounded event summary independently of live
control, preserving the desired catch-up effect without blocking entry.

### 5. Interest-managed delivery for larger maps

The server still simulates the complete world, but each client receives only
the map/entity deltas needed for its viewport, player state, diplomacy, and
existing information visibility. This introduces no fog of war. A low-detail
global map and global player summaries remain available, with exact viewport
pages, owned assets, selected opponents, incoming threats, and relevant actions
subscribed separately. Static terrain is paged and cached from the manifest/CDN.
The client must not allocate a second full simulation or full dynamic tile
mirror merely to observe a small viewport.

The current arbitrary paged-map boundary is the right seam for viewport-aware
GPU residency later; it is not permission to split one game into independent
gameplay sectors.

## Invariants and acceptance gates

- No OpenFront gameplay rule changes in this phase.
- The server tick is independent of browser frame rate and socket delivery.
- One dropped client may be disconnected or given a snapshot without stopping
  the match.
- A reconnect after a four-hour process restart resumes from checkpoint plus a
  bounded journal suffix.
- Server and client hashes agree in shadow mode for deterministic test seeds.
- A one-hour managed game continues with zero connected humans.
- Expanded Earth remains one continuous game; future page grids are not capped
  at 2 x 2.
- Capacity reports include simulation time, memory, outbound bytes, and number
  of worlds per worker, not only client FPS.

## Scale review: what the original sequence missed

### Size, population, activity, and age are different load axes

For this review, ten times larger means ten times Expanded Earth's tile area,
with the same tile meaning and local rules. It does not mean ten times both
dimensions, which would produce one hundred times the area.

| World                   |         Tiles | Terrain + ownership/flags at current 3 bytes/tile |
| ----------------------- | ------------: | ------------------------------------------------: |
| Current Expanded Earth  |    32,009,536 |                                             96 MB |
| 10 times area           |   320,095,360 |                                            960 MB |
| 10 times each dimension | 3,200,953,600 |                                           9.60 GB |

Figures use decimal bytes and exclude player tile sets, navigation, borders,
entities, journals, caches, snapshots, transport, and graphics. Widening owner
IDs increases the per-tile budget. Paging allocations currently keeps all
pages resident; it does not by itself bound total memory.

Population must be specified independently. Keeping roughly the current actor
density at ten times the area would require roughly 21,000 actors, beyond the
12-bit owner field's 4,095 nonzero IDs. Widening IDs affects packed updates,
textures, lookups, and replay formats. Dense pairwise relation storage also
grows quadratically with actor count. Large maps with the same population and
large maps with the same population density must be benchmarked separately.

### One simulation has a serial dependency problem

`GameImpl.executeNextTick` mutates a shared game sequentially through ordered
executions. Attacks can alter territory, reserves, opposing attacks, and
diplomacy in the same step; Nations and rail/ship systems cross storage pages.
Assigning pages to threads without dependency analysis changes results.

First profile representative expansion, dense wars, shipping/rail activity,
and nuclear bursts. Replace repeated scans with maintained indexes and caches
whose invalidation preserves behavior. Schedule existing periodic work at its
exact original tick. Parallelize only work shown to commute or pure queries
against the appropriate state version, then commit results in original order.
Running all queries against the beginning-of-tick state is not automatically
equivalent to today's sequential observations. A native or WASM hot loop is an
option only after profiling and equivalence tests; it is not a scale guarantee.

### Week-long play conflicts with current lifecycle policy

`WinCheckExecution` forces FFA and eligible team winners at 170 minutes of game
time, regardless of area. `GameImpl.elapsedGameSeconds` uses ten ticks/second.
`GameServer.phase` separately expires managed worlds at their configured
deadline. Week-long worlds therefore need an explicit lifecycle exception for
these limits. Retaining every current rule literally and also guaranteeing a
week-long session is impossible in this checkout.

Preserving combat, economy, structures, AI, and conquest victory while allowing
a longer lifecycle is a coherent target. It still cannot guarantee a week to
victory: current economy and conquest formulas depend nonlinearly on owned
area, and larger geography changes distances, density, and strategic balance.
World duration and an offline player's survival are separate playtest questions.
No timeout or rules changes are made by this review.

### Durability and updates require their own architecture

At ten ticks/second, one week is 6,048,000 ticks. Retaining every turn in live
arrays or loading the complete journal into IPC is not a sustainable recovery
strategy. Bound the live tail and archive older journal segments.

Checkpoints must include execution queues, ordering, every PRNG, pending
attacks, navigation dependencies, and references between entities. A tile dump
cannot resume the engine. Save at a consistent committed tick with immutable
generations/copy-on-write or another measured strategy; serializing a live,
mutating graph in a background worker is not safe by itself.

The current summed player hash omits much deterministic state and cannot prove
equivalence. Add canonical state comparison and restore-and-continue tests.
Journal acknowledgement must precede announcing durable commitment; current
worker-to-master batching does not provide that acknowledgement contract.

Pin each running world's engine build, map version, and protocol. Web/API deploys
should leave its simulation running; crashes still require checkpoint recovery.
New worlds can adopt a tested upstream release. An ongoing world cannot safely
switch to the latest rules every four hours without a validated migration.

## Revised implementation gates

1. Build useful load measurements: full process memory plus array buffers,
   tick distributions by game phase, outbound bytes, and active-work counts.
   Test the production Debian hardware as well as this Windows development host.
2. Deliver one playable end-to-end authoritative match on the current board:
   server simulation, render-state join, action queries, input acknowledgements,
   reconnect, and bounded client queues. A short shadow parity test gates this
   switch; shadow execution alone gives the player no performance improvement.
3. Prove complete server recovery, client resynchronization, and deploy isolation
   before calling long sessions supported. Test joins to aged fixtures without
   replaying their age on the client.
4. Move client terrain and GPU state to bounded page residency with a global
   overview. This is a prerequisite for the ten-times-area demo, not deferred
   polish. Preserve the map appearance, sampling, and gameplay interactions.
5. Test 1x, 2x, 4x, and 10x area with independent density and conflict controls.
   Widen IDs when the population scenario requires it. Optimize the measured
   critical path; introduce intra-world parallelism only where equivalence holds.

Proposed acceptance targets, not measured achievements: sustained ten simulation
ticks/second under representative wars with spare CPU capacity; no accumulating
simulation debt; bounded phone memory and delivery queues; control within five
seconds after required view data arrives regardless of world age; acknowledged
commands recovered after abrupt restart; deterministic continuation after
snapshot restore; global-map access and remote-threat feedback retained.
No simulated ticks may be silently skipped to satisfy these targets.

References used in this review:

- Node memory accounting: https://nodejs.org/api/process.html#processmemoryusage
- Factorio's shared-memory parallelism findings:
  https://www.factorio.com/blog/post/fff-215
- Factorio's active-work and indexing optimizations:
  https://www.factorio.com/blog/post/fff-421
- Snapshot delta/baseline compression:
  https://www.gafferongames.com/post/snapshot_compression/
