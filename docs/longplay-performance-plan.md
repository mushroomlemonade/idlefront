# Mature longplay: sustained 10 TPS

## Four-workstream implementation: September 25, bounded follow-up

Implemented within the user's 45-minute time box:

1. **Spatial queries:** maintain occupied cells by unit type. Sparse missile
   queries visit only occupied cells; dense queries retain the old traversal
   and skip geometrically impossible cells. Row-major, requested-type and Set
   insertion order are preserved, including predicate order and duplicate
   requested types. Grid membership tracks its actual indexed cell through
   skipped presentation positions and removal. No combat-rule changes.
2. **Navigation:** retain up to eight completely proven, bounded isolated-water
   components, including dry source boundaries. Reuse the proof for different
   origins and destinations within that component. Corridor-only failure or
   budget exhaustion is never cached as global disconnection. Water conversions
   invalidate immediately, including before graph rebuild. Applies to native
   synchronous routing and routing workers. Successful A* tie order, costs,
   construction, aggression and fleet limits remain unchanged.
3. **State-based catch-up:** compact only wholly unsent, single-packet,
   replaceable live state during a backlog. Preserve event/fog/rail/motion-plan,
   capture, construction/death and attack-array membership barriers. Numeric
   attack patches remain indexed against the same arrays. Snapshot and in-flight
   buffers are untouched; shared buffers are never mutated. Limit merge span to
   ten ticks, input bytes to 4 MiB, numeric record counts, and a shared per-game
   15 ms/100 ms work allowance (one synchronous merge can overrun it). Preserve
   queue caps and no-ACK timeout. These optimizations do not replay or skip any
   authoritative simulation ticks.
4. **Endurance verification:** added rolling 600-tick wall TPS, p50/p95/p99/max
   tick work, over-budget ticks, debt growth, fleet/SAM counts, worker/process
   memory and per-view queue/compaction measurements. Added a read-only,
   streaming soak-report command and repeated mature-state reconnect tests.
   The eight-hour soak itself cannot fit inside 45 minutes and remains an
   acceptance gate, not a completed result.

### Measured mechanism checks

- 50,000-unit synthetic spatial fixture, map dimensions 12,324 × 5,844,
  5,000 queries per case, five alternating runs: sparse missile-query median
  228.72 → 4.51 ms (98.0% lower); local fleet-query median 215.85 → 203.52 ms
  (5.7% lower). Results and ordering match the frozen implementation. These
  are deliberately synthetic distributions, not a predicted whole-match gain.
- Reusable connectivity: 100 varied endpoint requests into a synthetic
  7,936-tile isolated basin took 173.47 ms with the previous search-local proof
  and 6.70 ms with component reuse (99 cache hits). Opening the separating wall
  invalidated the proof and produced the same successful route as the reference.
- 2,000 moving warship updates plus 2,000 player-stat updates across 120 queued
  ticks: 73.07 MB input → 13.40 MB delivered, 98 superseded frames compacted,
  8.53 MB peak queued. Direct compaction median 10.84 ms, p95 13.93 ms on this
  host. The benchmark exercises the merge directly without the production CPU
  budget, so it is an upper bound on compaction coverage, not a network/device
  benchmark. Real event-bearing frames are deliberately retained.
- Three reconnect cycles to a synthetic 12,000-unit snapshot stamped at tick
  288,000, with 30 live updates queued during delivery: all units and final
  player stats preserved; queued bytes drain to zero. This tests real snapshot
  encoding, delivery and client ingestion, not historical mature AI state,
  real radio bandwidth or iPhone GPU behaviour.
- Whole test run: 3,707 passing tests in 403 files after fixing a missing close
  reason in disconnect diagnostics. Two nginx shell-generation tests cannot
  run here because `sh` is unavailable; excluded from that passing run.
  TypeScript and targeted lint pass. Production client build passes with
  existing missing stone-texture, chunk-size and dynamic-import warnings.

Reproduce checks (each command is bounded and does not touch running matches):

```text
node --import tsx scripts/benchmark-spatial-queries.ts
node --import tsx scripts/benchmark-water-connectivity.ts
node --import tsx scripts/benchmark-view-catchup.ts
node --import tsx scripts/report-longplay-health.ts BACKEND_LOG GAME_ID
```

The report defaults to an eight-hour requirement and refuses to call a short
test a passed soak. It reports server gates separately from device validation.
RSS is shared process memory, not memory attributable exclusively to one world.
Latency includes worker computation and main-thread view publication; wall TPS
also captures scheduling/IPC stalls. Raw private captures and backups stay out
of the repository.

Preview: checked database backup made, changed runtime sources verified and
preview backend restarted; both workers report ready, health endpoint returns
OK, and the iOS Expo manifest responds successfully. No production push or
schema migration. The previously retired match stays retired and other saved
worlds are preserved. Start a **new 9× longplay** for the next acceptance test;
background/reopen on iPhone early, then again once fleets and warfare grow.
Sustained 10 TPS for an entire mature longplay is still **unproven**.

## Mature-world profiling and reconnect pass

The versioned 9× longplay was sampled for 20.38 seconds before being explicitly
ended at the user's request. Its journal and a consistent, integrity-checked
database backup are retained privately. Only the named match was retired.

Main simulation-thread profile (not whole-host utilization):

| Work                                     | Sample share |
| ---------------------------------------- | -----------: |
| Nearby-unit queries (UnitGrid self time) |       38.94% |
| Water repair                             |       15.07% |
| Other pathfinding                        |        4.03% |
| Route smoothing                          |        1.23% |
| Patrol destination selection             |        1.18% |
| Snapshot/view encoding                   |        3.14% |
| Garbage collection                       |        1.00% |
| Idle/waiting                             |        5.85% |
| Remaining simulation/runtime             |       29.56% |

Ship target selection and SAM targeting are substantial callers of the spatial
queries. Inclusive caller percentages overlap and must not be added together.
The world differs from the earlier profile: this is not a controlled attribution
of improvement to the retry change. Its final ten logged samples covered 900
ticks at approximately 3.97 TPS, with 151–317 ms sampled tick work and roughly
3,954 seconds accumulated debt. These sparse log samples are not percentiles.
Sustained 10 TPS is NOT achieved.

Reconnect evidence: snapshots grew from about 40 MB / 2,100 packets to 64 MB /
2,800 packets. No device crash dump or historical close-code telemetry exists,
so the exact earlier disconnect trigger is not claimed as proven.

Implemented:

- Snapshot delivery may pipeline up to 64 packets, capped at 2 MiB in flight;
  one oversized native packet can proceed alone. Live delivery remains eight
  packets. The 128 MiB backlog limit and 30-second no-ACK timeout remain.
- Explicit failure diagnostics distinguish backlog bytes/frames, packet limit,
  missing acknowledgements and send errors. Close codes/reasons and completed
  snapshot delivery duration are logged. No gameplay state is dropped.
- Client snapshot fragments still ingest state and upload terrain/rail changes,
  but defer full unit, structure, label and related GPU uploads until the end.
  Structure dirtiness persists across fragments. Notifications/effects retain
  their update paths; trails advance once per completed logical snapshot.

Verification: 206 tests across 34 focused suites passed, TypeScript and targeted
lint passed. A fake-clock delivery regression drains 2,800 20 KB chunks under
10 seconds at a simulated 150 ms ACK RTT while adding 1.5 MB of live traffic
per 150 ms. This excludes bandwidth, decompression, GPU and iPhone processing
costs; it is not device performance evidence. An ingestion test verifies no
entity GPU uploads across 102 initial/intermediate fragments, followed by one
complete upload and normal live operation.

Preview rollout: changed sources verified against the canonical checkout,
backend restarted, both workers ready and health endpoint healthy. Development
web server verified to serve the snapshot-upload change; Expo remains running.
Production build passed with existing missing stone-texture references and
bundle-size warnings. No production push. iPhone reconnection and multi-hour
stability still require playtest validation.

Next four optimization steps:

1. Profile and optimize typed spatial queries. Avoid scanning irrelevant unit
   types and allocating/sorting large candidate lists for each ship/SAM every
   tick. Preserve exact range, priority, alliance and deterministic tie rules.
2. Reduce remaining navigation churn. Measure local terrain invalidation,
   corridor failures and synchronous routing work; consider reusable local
   connectivity and bounded preparation queues rather than more blind threads.
3. Architect state-oriented catch-up/live deltas if delivery still falls behind:
   compact superseded presentation state without dropping ordered diplomacy,
   rail, destruction or fog transitions. Add per-view queue/drain measurements
   before changing semantics. Never expose hidden state to save bandwidth.
4. Run a full-match longplay acceptance soak with automated rolling TPS,
   p95/p99 tick timings, clock debt, memory, fleet counts and repeated mobile
   reconnects. Fix regressions before declaring longplay ready; then apply the
   validated architecture and measurements to longer IdleFront sessions.

## Failed-patrol scheduling checkpoint

New managed pressure worlds now persist `warshipPatrolScheduling: "v1"`.
Missing flag retains old patrol decisions and random sampling; loading an
existing runtime never inserts the flag. This applies equally to quickplay,
longplay and idle presets, independently of map scale. No active runtime has
been migrated or restarted for this change.

- Failed patrol routes or exhausted destination sampling back off for
  10, 20, 40, then 50 simulation ticks, with a deterministic 0–6 tick ship
  offset. Successful routes never back off.
- Position, owner, patrol area and water-graph changes invalidate the wait.
  Explicit movement commands reset it even for the same patrol tile.
- Target selection, firing, trade pursuit, healing and retreat execute before
  the patrol wait. Fleet sizes, build costs and strategic aggression are unchanged.
- New sampling has at most 384 candidate draws including off-map coordinates
  and shoreline fallback. Old sampling remains for old saves.
- Repeated diagnostic warnings aggregate into fixed messages instead of
  logging per-player failures on every retry.

Regression evidence: forced unreachable patrols produce fewer than 16 searches
over 600 ticks versus 600 with the legacy scheduler. This is a controlled
mechanism test, not a mature-world TPS measurement. Warship combat/healing tests
run under both scheduling versions. Full focused verification is recorded in
the implementation handoff.

### Next steps, in order

1. Run a versioned new longplay preview and a controlled mature-fleet benchmark;
   compare successful/failed searches, core tick p50/p95/p99, total wall TPS,
   clock debt, fleet activity, memory and log growth. Do not modify an old
   world's initial config and call that replay-compatible.
2. Reprofile the largest remaining cost. Likely navigation candidates are route
   invalidation after terrain changes, repeated coarse-to-fine repair, and
   patrol routes still calculated synchronously despite routing workers.
   Decide from measurements, not presumed percentage improvements.
3. Verify representative 9× longplay at 10 TPS with late-game fleets, combat,
   reconnects and multiple observers, then an uninterrupted 8-hour soak.
   Whole-match reliability remains unproven until these gates pass.
4. Only then extend the same instrumentation and validated optimizations to
   IdleFront's longer simulation, population and persistence lifetimes.

## Implementation checkpoint: September 25

Two 20-second CPU profiles of the severely slow mature 9× world attributed
approximately 73% of main simulation-thread samples to water route repair,
12% to other pathfinding, and 4% to route smoothing. These are sampled CPU
fractions, not predicted TPS gains or aggregate routing-worker utilization.
The earlier, different world described below was less severely affected.

Six bounded captures of actual repair calls taking over 10 ms all returned
no route, after 62,418–200,000 A* expansions. Raw captures remain private.

Implemented a deterministic, search-local reverse connectivity proof:

- Short searches are unchanged. After 4,096 expansions, attempt one reverse
  flood from the destination, bounded to 8,192 queued tiles.
- Exhausted destination component proves failure; budget exhaustion or meeting
  the forward search falls back to the original A*, with its exact tie order
  and 200,000-expansion cutoff. No negative result survives terrain changes.
- No changes to fleet counts, combat, strategic decisions or random draws.
- Added capture benchmark and regression tests for disconnects, terrain changes,
  short searches, endpoint exceptions, source duplication and budget fallback.

Five alternating measurements per captured request, medians in milliseconds:

| Capture | Baseline | Candidate |
| ------- | -------: | --------: |
| 0       |    17.98 |     18.88 |
| 1       |    16.72 |      2.59 |
| 2       |    47.14 |      1.19 |
| 3       |    53.57 |     55.69 |
| 4       |    23.10 |     24.17 |
| 5       |    22.62 |     23.26 |

Approximately 31% reduction in summed medians for this deliberately slow,
failure-only sample. This is NOT a representative whole-world benchmark;
four requests are slightly slower. A larger reverse budget caught five cases
but imposed an unacceptable roughly 25 ms extra cost on the remaining case,
so it was rejected. Successful-search heap tie changes were also discarded.

Verification: 40 pathfinding/simulation test files, 248 tests passed;
TypeScript no-emit and targeted ESLint passed. A separate focused run passed
16 tests including the new reachability cases. Not deployed, no restart,
no sustained-10-TPS claim. Temporary diagnostic scheduled task removed.

Next: reduce repeated unreachable patrol route requests with explicit replay
compatibility, benchmark mixed successful/failed requests, then compare whole
mature-world ticks and run the acceptance soak below. The optimization above
alone cannot reasonably turn a ~1.6-second tick into a 100 ms tick.

## Evidence and limits

The September 25 preview investigation found real server-side clock debt.
Three recent sampled authoritative ticks took approximately 160–220 ms, with
150–161 ms in core simulation, 0–53 ms navigation preparation and 6 ms encoding.
Two consecutive 100-tick intervals took approximately 24 and 22 seconds: about
4–4.5 TPS for that observed world, not confirmation of the reported 1 TPS in
the player's current session. Samples had zero connected views. Identify the
exact playtest world and account for other active/recovering worlds before
attributing the entire overnight slowdown to one cause.

The backend log was approximately 240 MB and its tail repeatedly reported
warship patrol target failures. `WarshipExecution.randomTile` allows 1,500 failed
in-bounds candidates, then retries with shoreline allowed. Out-of-bounds draws
do not advance the attempt budget. `patrol` retries when no target is found,
without a failure cooldown in that method. This is a strong profiling lead,
not a measured percentage of CPU time.

## Implementation sequence

1. Preserve the relevant journal/config and a consistent database backup outside
   the repository. Identify all active/recovering worlds and resource contention.
   Use the existing recorded-playtest profiler to capture a bounded mature-world
   sample, not only a fresh map. Record wall TPS, tick p50/p95/p99, clock debt,
   CPU/GC/RSS, entities, failed patrol searches and route queue sizes.
2. Bound every patrol candidate attempt, including invalid coordinates. Add
   deterministic staggered retry cooldowns and cached valid patrol destinations
   with ownership/connectivity invalidation. Failure should mean a safe stationary
   ship until retry, not repeated expensive searches. Aggregate warnings; do not
   merely hide them. Keep tactical targeting and combat responsive.
3. Profile and reduce route churn: reuse valid routes, back off unreachable
   destinations, deduplicate requests and bound strategic planning per tick.
   Existing parallel routing already runs workers; adding threads is not the
   default solution. Authoritative outcomes must not depend on worker timing.
4. Optimize measured core hot spots: spatially bounded combat queries, cached
   port/coast candidates and staggered nation strategic decisions. Preserve
   aggressive AI, fleet replenishment and normal troop/resource accounting.
   Do not solve this by silently making nations passive or removing fleets.
5. Measure view and persistence costs, including work with no viewers. Current
   encoding samples are smaller than core cost, so prioritize accordingly.
   Avoid redundant presentation snapshots without losing recovery journals,
   reconnect correctness, fog filtering or elimination state.
6. Run matched before/after mature-state benchmarks, then a long real-time soak
   with reconnects and mobile observers. Never fast-forward game time by skipping
   simulation ticks or mislabel replay/catch-up throughput as live TPS.

## Acceptance gates

- Representative 9× longplay with normal nation/tribe counts and mature fleets.
- Rolling live TPS approximately 10; no accumulating clock debt over the soak.
- Target total tick p95 below 80 ms and p99 below the 100 ms budget, measured on
  the actual preview host with co-resident workloads documented.
- At least an 8-hour wall-clock soak after a shorter regression run; report
  simulation time advanced, stalls, reconnect latency and peak memory/log growth.
- Deterministic regression tests for failed patrol searches, map edges, isolated
  water, invalidated targets, manual orders and alliance/fog legality.
- If these gates fail, report the measured bottleneck and next bounded change;
  do not claim readiness based on average TPS or tiny fixtures.

Simulation changes that alter random draws/decisions need explicit replay/version
handling. Existing saves must not silently acquire incompatible rules. Production
and repository migration remain outside this profiling/planning task.
