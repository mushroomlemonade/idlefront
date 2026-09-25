# Safe simulation scaling pass — 2026-09-08

## Changes

- Global unit counts now maintain the sum of live unit levels at build,
  deletion, and level-change boundaries. Each fleet-size query is O(1),
  previously O(players + all units). Ownership transfer does not change totals.
- Paged map cardinal-neighbor collection no longer allocates a callback.
  Border checks short-circuit directly. Diagonal traversal uses direct offsets
  instead of nested coordinate loops. Original traversal order is preserved.
- No combat values, trade destinations, RNG calls, map size, or tick interval
  were changed. The configured server interval remains 100 ms (10 TPS).

## Validation

37 focused tests passed: global count lifecycle, paged map seams/edges/neighbor
order, ports, trade scaling, ships, and train stations. Typecheck passed.

Seeded headless 9x map run: expandedgiantworldlarge, 2,000 bots plus nations,
600 game ticks after 302 spawn ticks, seed `scale-pass`.

| Metric | Before | After |
| --- | ---: | ---: |
| Mean tick ms | 88.5 | 82.6 |
| p95 tick ms | 125 | 113 |
| Ticks over 100 ms | 213/600 | 140/600 |
| Final hash at tick 900 | 88725554963106830 | 88725554963106830 |

These timings include execution and CPU profiling. Background load differed
(the baseline overlapped the live server and database backup), so the timing
comparison is indicative, not an isolated speedup measurement. This short run
had only six units; it does not measure the fleet-count optimization's benefit
in a mature trade-heavy world. Matching hash is useful regression evidence,
not proof covering every possible game state.

Attacks consumed approximately 73–75% of execution time. The remaining large
scaling problem is active conquest/frontier work, not initially trade. Next:
profile mature saved-world replay, benchmark under controlled load, reduce
frontier bookkeeping while preserving ordering/RNG, and separately evaluate
exact invalidation of port/route lookup caches. Do not restrict destinations
or skip distant simulation as a performance shortcut.

## Recovery

Saved-world backup completed before restart:
`.data/backups/worlds-before-scale-pass-20260908.sqlite`.
Existing game `GGqocjrj` / world `world_1VvV9DzhiWpNvzla` was retained.
Dev backend logs: `.dev-logs/server-scale-pass-20260908.*.log`.
Production was not changed.
