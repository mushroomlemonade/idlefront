# Mature fleet follow-up — 2026-09-10

The user-authorized retired games remain stopped; journals are preserved.
Production has not been changed. This follows the four-stage pass and the
27x expansion-window measurements in `steady-tps-followup-20260910.md`.

## Explicit acceptance priority

The user reiterated that **p99 must fit the 100 ms tick budget**. Average
capacity alone is not a pass. Measure recurring slow ticks, not only the
single largest pause. Keep compute duration, completion lateness and client
delivery intervals separate: a paced 100 ms interval leaves no slack for
ordinary timer jitter, so report that jitter honestly rather than rounding
it away or increasing simulation speed to manufacture a passing percentile.
Validation still needs the large-world and mature-fleet scopes, ordered
delivery, unchanged gameplay, and no growing backlog.

## Recorded input and measurement boundaries

Fast fame (`1zHqb4zj`) contains 15,647 recorded turns, 76 human build orders,
and substantial later ship traffic. It is **Great Lakes, 2000x1300**, not the
27x Earth world. Frozen input SHA-256:
`f5cef2ebb570e13f28cbfaf82019d5f02eb3b59822a175c8823b88f297237f70`.

Reports live under `.dev-logs/profiles/`. The replay harness reads the world
database only to stop itself if a user starts an active game. It never writes
game state. CPU profiling runs from turn 13000 to the end. Hashing/reporting
are outside per-tick timing; sampled CPU includes their overhead and awaited
worker time. An `idle` sample is not evidence that the whole machine was idle.
The final 1000-turn windows ran without concurrent test/benchmark workloads.

## Before this follow-up

`fast-fame-mature-current.json` uses the already optimized contiguous layout,
staggered labels, exact route cache and four-worker route preparation pool,
but still uses the JavaScript Map search index and full fleet scans for
per-player type queries and factory counts.

- Last 1000 mean: 64.824 ms; p99: 151.120 ms; max: 280.857 ms.
- 27 of those 1000 turns exceeded 100 ms. Compute capacity 15.43 TPS is NOT
  evidence of evenly delivered 10 TPS.
- Full replay maximum: 1501.553 ms at turn 12920.
- Route pool: 11,467 batches, 50,465 jobs, zero errors, four workers.
- Exact cache: 57,234 hits from 93,544 queried routes.
- Final gameplay update hash:
  `9ec3d88f88b4fc87f6bc9c22652d40a8d6f653378c61ca8b423f43ced2e28252`.

Late-window profile now points to train spawn decisions, unit queries,
transport retaliation and spatial unit searches. Main-thread self samples:
`shouldSpawnTrain` 7.57%, player `units` 7.24%, game `units` 6.45%,
`UnitGrid.nearbyUnits` 5.71%. These are percentages of sampled wall duration,
including 30.22% idle/await samples, not exclusive percentages of total CPU
across the worker pool. They should not be directly compared to an earlier
live profile from a different point in the match.

## Implemented candidates

1. **Incremental player type indexes and level totals.** A single-type query
   scans/copies matching units only, rather than the entire owner's fleet.
   Global single-type queries preserve player order and then owner insertion
   order without allocating one result per player. Factory-count queries used
   by every train station become O(1), previously O(all owned units). Counts
   update on build, capture, upgrade, downgrade and deletion. Multi-type
   queries retain their original traversal; mutable query results remain copies.
2. **Reusable typed tile-to-node lookup for water repair.** Generation stamps
   make reset O(1); storage grows with the search, not world dimensions. No
   search order, heap comparisons, route cutoff or terrain semantics change.
   Sequential synthetic comparisons against the same search with a Map index:
   blocked 75.214 -> 60.607 ms; detour 39.361 -> 31.718 ms; many-blocks
   75.163 -> 61.115 ms per 12-query batch (five-round medians). This is about
   19% less search time, NOT a 19% whole-game speedup.

283 targeted tests across 35 files passed, including randomized index/count
comparisons through ownership changes, real route workers, route equivalence,
train stations, nation behavior, fog, rejoin and simulation host parity.
Typecheck still reports only the two existing missing declarations for
`idle-dev-supervisor.mjs` / `idle-expo-proxy.mjs` in their test imports.

## Completed comparison

`fast-fame-mature-indexed.json` completed all 15,647 turns. All **156 rolling
checkpoints and the final gameplay update hash match exactly**. Identical route
query/hit counts and 50,465 preparation jobs; zero pool errors in both runs.
Cosmetic name placement is outside the gameplay hash, as documented previously.

| Metric | Before | Indexed |
| --- | ---: | ---: |
| All-turn mean | 49.460 ms | 38.350 ms |
| Last 1000 mean | 64.824 ms | 46.792 ms |
| Last 1000 p99 | 151.120 ms | 140.275 ms |
| Last 1000 maximum | 280.857 ms | 282.297 ms |
| Last 1000 turns over 100 ms | 27 | 16 |
| Peak sampled RSS | 1279 MiB | 999 MiB |
| Whole replay maximum | 1501.553 ms | 1437.609 ms |

This is **27.8% less compute in the mature final window** and 22.5% less across
the replay. It is a cumulative unit-index + typed-lookup comparison; do not
attribute the entire gain to either change alone. The cold-query synthetic
comparison isolates the lookup change separately.

Main-thread profile time in train spawn decisions and broad unit scans drops
sharply. Remaining frequent work includes spatial unit searches, ship stepping,
and water routing. Awaited route-pool batch time drops from 215.9 to 181.0 sec
over the whole recorded simulation; this is not aggregate worker CPU time.

**Goal remains active.** The same exceptional turn **12920** still takes ~1.4
seconds, and turns 14642 (~510 ms), 13891 (~432 ms), and 9880 (~414 ms) remain
slow. This repetition suggests a specific simulation workload, not sufficient
evidence to blame OS scheduling. The profile starts at 13000 and therefore
misses the largest stall. The next bounded diagnostic should profile around
12500–13050 and include tick/phase clock alignment, before broader rewrites.
No steady-delivery or mature 27x claim is justified by this smaller-map replay.

No persistent game was started or deleted by either benchmark. Their workers
closed normally at completion. New development simulation workers load the
updated code; no backend restart or production deployment was required.
