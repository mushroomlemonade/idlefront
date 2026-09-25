# Attack planning: feasibility gate before worker execution

## Why this needs a structural pass

The 27x frozen expansion replay still spends approximately 93 ms per tick
on average, with compute p99 above 100 ms. OS thread accounting closely
matches elapsed time; waiting is not the main cost. Attack execution is the
largest inclusive stack, but much of that stack is authoritative conquest
and cannot simply be sent to another thread.

The following additional small changes were measured independently and removed:

| Final 1000 turns | Mean | p99 | Max | Over 100 ms |
| --- | ---: | ---: | ---: | ---: |
| Fresh retained hash control | 92.832 | 121.929 | 156.394 | 177 |
| Reject stale heap targets before adjacency | 93.096 | 138.235 | 168.612 | 169 |
| Single-lookup attack-border mutations | 93.073 | 136.048 | 167.732 | 172 |

All timings are milliseconds. All runs matched the same gameplay digest and
22 checkpoints. These results do not establish a useful improvement. The
original runtime code is restored; tests for stale target behavior, exact
dequeue/combat/random order, and attack-border counts/iteration remain.

The attack-border test initially supplied parameter arrays incorrectly to
Vitest (17 was passed instead of [17,22]); correcting the test data shape made
both cases pass. This was a test-fixture error, not a simulation divergence.

Reports under `.dev-logs/profiles`:
`27x-expansion-stale-queue.json`, `27x-expansion-attack-border-set.json`, and
`27x-expansion-hash-control-sept11.json`.

## Measurement first

`IDLE_BENCH_ATTACK_ACCOUNTING=1` on `benchmark-recorded-playtest.ts` records
per-tick attack execution time and call count separately for wilderness and
player targets. This adds diagnostic wrapper overhead and includes both
planning and mutation: it is not an acceptance benchmark and must not be
reported as an amount of work that can all run in parallel.

The first feasibility question is whether wilderness work is a sufficiently
large fraction of the expansion bottleneck to justify a restricted exact
planner. Player combat, death/capture cascades and diplomacy are more coupled;
they remain on the original path until separately proven eligible.

### Measured split

`27x-expansion-attack-accounting.json` completed all 2200 recorded turns and
matched the gameplay digest and all 22 checkpoints. In the final 1000 ticks:

- Whole measured tick mean: **93.464 ms** (diagnostic wrapper overhead included).
- Wilderness attack mean: **51.959 ms/tick**, 1,114,537 calls total.
- Player-target attack mean: **5.306 ms/tick**, 124,610 calls total.
- Wilderness execution accounts for about **55.6%** of measured tick time;
  all attack execution about **61.3%**. Both include serial conquest effects.

This is enough coverage to justify testing a wilderness-only shadow planner,
not enough to promise a specific speedup. The next measurement must separate
planner cost, authoritative effect application, state transfer and validation.
In particular, do NOT claim that all 52 ms can be offloaded. The existing
profile attributes a substantial part of attack execution to conquest.

After restoring all runtime experiments, 34 tests across seven attack,
capture, pacing and ordering files passed. Benchmark workers closed normally.
No live game was interrupted and no production changes were made.

## Proposed staged architecture

The first synchronous shadow correctness gate is now implemented and measured
in `docs/wilderness-shadow-planner-20260911.md`. Worker transport, dependency
validation and plan application below remain unimplemented.

1. Extract a deterministic, side-effect-free attack planner behind an
   experimental switch. Start in **shadow mode**: compare its planned result
   with the existing synchronous execution, but apply ONLY the existing code.
   Preserve the Float32 priority behavior, duplicate heap entries, heap tie
   ordering, PRNG state, border operations, troop losses and terminal branches.
   Do not deduplicate the heap or approximate combat as a shortcut.
2. Capture the actual read dependencies: ownership/terrain chunks, attack
   state, applicable configuration/fog budget and any player properties used.
   A local overlay must make earlier planned conquests visible to subsequent
   calculations within that same attack. Custom Config overrides and unsupported
   paths must remain on the original execution, not silently bypassed.
3. Only after single-thread shadow equivalence, prepare plans using a bounded
   computational worker pool and shared read-only world storage. Use a bounded
   copy/delta strategy; do not copy the 216-million-tile world into each worker
   or recopy it in full every tick. Measure message/copy/validation overhead
   before claiming a benefit. Coordinate with the existing water-route pool.
4. The one authoritative writer validates dependency versions at the attack's
   **original execution position**. A conflict or incomplete plan takes the
   original synchronous path. Valid results must apply effects in the original
   order, including observer-visible border/troop/ownership changes. Background
   workers never spend troops, capture territory or advance global tick state.

## Important risks / gates

- A snapshot from the start of a tick is not automatically valid: preceding
  executions within that tick can change the state an attack observes.
- Neighboring expansions can compete for the same wilderness. Validate the
  read set, not just the planned writes. Invalidation must be conservative.
- A planner that costs as much as the serial code plus frequent fallback can
  make tail latency worse. Measure coverage, conflict rate, copied bytes,
  serial planning cost, worker service time and authority application cost.
- Serial conquest may dominate even after successful planning offload. The
  measured parallelizable fraction, not the inclusive attack stack, bounds
  the achievable speedup. Do not promise eightfold gains from eight workers.
- Full-replay state hashes/checkpoints, low-level heap/PRNG tests, concurrent
  frontier conflicts, fallbacks, fog, terrain changes and rejoin recovery must
  pass before using this for a live test.
- Acceptance still requires compute p99 <=100 ms and steadily delivered
  10 TPS without growing deadline debt, under the relevant large-world and
  mature fleet workloads. Loopback WebSockets are not proof of phone/internet
  behavior. No gameplay slowdown, reduced bot count, altered targeting or
  delayed conquest is permitted to manufacture the target.

This is a larger internal refactor, not an approved claim of a working parallel
attack engine. The existing playable implementation remains the fallback and
the recovery baseline. No production deployment or game restart is part of
this feasibility pass.
