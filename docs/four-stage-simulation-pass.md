# Four-stage simulation pass — September 10, 2026

Goal: improve actual authoritative tick cost and tail latency without changing
combat, economy, AI decision ordering, route traversal, or game speed.
Status: implemented; recorded-input parity passed; deployed to development at
20:15 EDT September 10. Production untouched.

1. **Territory updates:** a changed owner can affect only two players' adjacent
   border memberships. Third-party edges stay foreign; the loser necessarily
   gains a foreign edge. Only the winner needs its remaining edges checked.
   Tile updates, capture order and border insertion order remain unchanged.
2. **Ordered neighbor index:** direct contacts are updated in the changed
   tile's cardinal neighborhood. One first-contact witness per country tracks
   the earliest border occurrence, preserving seeded AI targeting order.
   If a first witness disappears, rebuild lazily on the next query. This avoids
   eagerly maintaining every intermediate frontier during rapid expansion.
   The first prototype's per-tile heaps increased memory and tick cost and was
   rejected before deployment; the index now scales with neighbor count rather
   than retaining an object graph for the whole border.
   Shore sampling retains every-tenth-shore semantics. Its sampled border list
   is rebuilt on border/terrain revision changes, not on every nearby query;
   target ownership and fallout are always checked against current state.
3. **Exact water-route cache:** bounded by both entry count and retained route
   nodes. Keys distinguish single/multiple sources and preserve source order.
   Returned paths are copies. Terrain conversions and water-graph revisions
   invalidate caches; no reversed-route assumptions or destination shortcuts.
4. **Shared-terrain route workers:** up to four workers by default, terrain
   shared once rather than copying a world per worker. New trade executions
   enqueue optional route hints. Before the next authoritative tick, coarse
   routes are prepared serially and full-resolution refinement runs in a
   worker pool. Results are indexed by request order and accepted only at the
   same navigation revision. Actual spawns, resource spending, diplomacy and
   movement remain in the existing ordered simulation. Unanticipated routes
   and worker failures use the synchronous implementation. All incoming
   simulation commands serialize across this preparation barrier.

Workers warm before live play, avoiding a process-start spike on the first
fleet. `IDLE_ROUTE_WORKERS=1` selects synchronous preparation; maximum 8.
Pool metrics and preparation duration are included in sampled server logs.
This is NOT parallel combat ownership or regional simulation. Initial parallel
preparation targets new trade ships; exact route reuse benefits all water
callers. Transport/warship misses still use their normal synchronous fallback.

Validation must cover exact ordered borders/contacts, shore/fallout changes,
cache invalidation, real worker results, failed workers, and recorded-input
update hashes. Compare the same frozen 27x journal sequentially, not under a
competing game. Do not describe synthetic throughput as sustained live TPS.

User authorized retiring the 27x test after dying. Its frozen input is
`.dev-logs/profiles/6xoPucFs-replay-20260910.json`, turns 0–4554, SHA-256
`2cdd869c1d22b6958edaba7518ab0bd13efee41b0e6115b4bc3d621cdc93f068`.
All journals are retained. No production push or automatic restart of a new
user match is authorized by this document.

## Validation so far

- 175 focused tests passed across 23 files, including real shared-memory
  workers, terrain invalidation, failure fallback, randomized ordered borders
  and contacts, trade ships, and the authoritative simulation host.
- Typecheck has no new implementation errors. It remains blocked by two
  existing missing declarations for idle-dev-supervisor.mjs and
  idle-expo-proxy.mjs in their test imports.
- The first eager-index replay was stopped before completion after ~1,400
  turns: it exceeded 4 GB RSS and had ~230 ms ticks. It was not deployed and
  did not produce a completed equivalence report.

## Recorded 27x results

Sequential isolated processes, identical frozen inputs, first 2,200 turns.
Reports: `.dev-logs/profiles/27x-before-four-stage.json` and
`.dev-logs/profiles/27x-after-four-stage-v2.json`.
The baseline restores the frozen pre-optimization border, nearby, cluster,
and water-refinement implementations. This is a cumulative comparison against
that baseline, not an isolated attribution to each new change.

| Metric | Baseline | Optimized |
| --- | ---: | ---: |
| All-turn mean compute | 126.81 ms | 99.86 ms |
| Last 1,000 mean compute | 179.88 ms | 138.04 ms |
| Last 1,000 p99 | 338.71 ms | 291.21 ms |
| Last 1,000 maximum | 365.94 ms | 329.20 ms |
| Last 1,000 compute capacity | 5.56 TPS | 7.24 TPS |
| Peak process RSS | 2.61 GiB | 2.92 GiB |

All 22 rolling checkpoints and the final ordered-update SHA-256 match:
`0d92157e9b86dfd5cc23c1751db5b7f84189ace42be423c5f67a5476be230d71`.
This is approximately 23% less compute in the heavy window, not steady 10 TPS.
983 of its 1,000 optimized turns still exceed 100 ms. No network/client pacing
is included. No altered game rules or reduced simulation rate were used.

The pool warmed four workers without errors, but this early replay window
contained no eligible multi-route preparation batches. Therefore these results
do NOT demonstrate a live fleet-throughput gain from parallelism; real worker
equivalence is covered separately by the paged-terrain tests. A mature fleet
profile remains necessary. The memory increase includes the warmed worker pool
and shared terrain copy; no per-worker world copies are made.

## Development handoff

No active persistent worlds were present before restarting. Previous w0/w1
workers and master were shut down through their registered graceful handlers.
New profile-accessible master PID: 12312; log files:
`.dev-logs/four-stage-backend-20260910.out.log` and `.err.log`.
The Backend scheduled supervisor is running again without duplicating the port.
Both direct and Vite-proxied `/api/health` report `ok`. The public Atlas Expo
manifest returns HTTP 200 with `application/expo+json`; web gate returns 200.
Existing cosmetics/privilege-refresher errors against localhost:8787 remain
visible in logs; this pass did not modify that external service configuration.
No new human playtest was run after deployment. The next validation should
measure every-tick cadence plus navigation batch statistics during a mature
fleet, not infer steady TPS from this offline benchmark average.
