# Wilderness planner: conservative mutation revisions

## Status and scope

This is a correctness/performance foundation for computational workers, **not
a live TPS improvement**. No worker plans are applied to game state. No live
game was restarted and nothing was pushed to production.

GameMapImpl and PagedGameMap now expose optional state observers. All packed
state mutators notify: ownership, fallout on/off, defense flags and updateTile.
Existing terrain observers cover terrain mutations. When no state observer is
installed, the hot setters only execute an optional callback check; no revision
index is allocated. Raw exposed page/buffer arrays must not be mutated while
tracking is enabled. The authority's mutation sites were inspected; existing
runtime writes use the setters. Initial array construction is outside tracking.

TileMutationIndex records uint32 revisions by spatial chunk. It deduplicates a
plan's read chunks and validates their captured revisions. Counter rollover
changes a global epoch and invalidates all old checkpoints; exhausted epochs
fail closed. Disposal unsubscribes and invalidates checkpoints. An index has
a 64 MiB counter allocation cap; unsupported maps/configuration fail explicitly.
The index is not instantiated by live SimulationWorker.

## Exact-oracle replay evidence

Two diagnostic replays used 2200 turns of 27x Earth (216,086,656 tiles), sampled
every 32nd eligible wilderness execution at start-of-tick. The exact checker
still runs and remains the authority for comparison. Chunk validity never
overrides a failed exact check. All accepted plans run the real simulation;
the planner never commits effects.

Both runs: 75,398 samples, 73,572 nonterminal prepared plans, 70,332 exact-valid
plans, 3,240 exact tile-state conflicts, zero missed tile-state conflicts and
zero verified-plan mismatches. Every one of 22 checkpoints and the full hash
match the original replay:
`0d92157e9b86dfd5cc23c1751db5b7f84189ace42be423c5f67a5476be230d71`.

| Chunk | Counter bytes | Revision validation total | Exact-valid plans retained | False conflicts |
| --- | ---: | ---: | ---: | ---: |
| 16x16 | 3,377,688 | 61.0 ms | 59,962 / 70,332 | 10,370 |
| 8x8 | 13,510,752 | 62.0 ms | 64,061 / 70,332 | 6,271 |
| 4x4 | 54,021,664 | 89.0 ms | 67,202 / 70,332 | 3,130 |

4x4 retains 95.55% of otherwise-valid plans (91.34% of all prepared plans) with
51.5 MiB of counters. It is the current 27x candidate; larger future worlds
need a coarser grid or a different bounded index under the allocation cap.

Revision capture totals: 16x16 522.0 ms; 8x8 703.1 ms; 4x4 957.7 ms.
The 8/4 comparison captured 1,639,741 / 3,121,859 chunk references across
73,572 plans. Current capture still walks read tiles on the authority; workers
can eventually return deduplicated chunk IDs under a coherent read barrier.

Do NOT compare revision validation alone with the full exact checker as though
both do the same work. The exact checker (2313.3 ms in the 8/4 run) also checks
attack state, config and global terrain scalars. Revisions replace its tile
portion only. Cheap attack stamps and configuration/global validation are still
needed, as are measured mutation-notification and copying/application costs.

Reports:
- `.dev-logs/profiles/27x-wilderness-revisions16-shadow.json`
- `.dev-logs/profiles/27x-wilderness-revisions4-8-shadow.json`

The second run installed both indexes simultaneously for coverage comparison;
its tick timings include two trackers, all shadow planning and both validators.
Neither diagnostic is a live/acceptance benchmark. Both processes completed and
closed their own navigation workers.

## Disabled-hook control

`.dev-logs/profiles/27x-state-hooks-control.json` completed 2200 turns with no
shadow planner or mutation index installed, matching all checkpoints/hash.
Final 1000: mean **94.372 ms**, p99 **120.371 ms**, max **140.413 ms**, 256 ticks
over 100 ms. Prior fresh control: mean 92.832 ms, p99 121.929 ms, max 156.394 ms,
177 ticks over 100 ms. The mean is 1.54 ms higher; one sequential comparison
does not separate optional-hook overhead from run variability. Do not claim
zero cost or an overall improvement. Account for this cost in the eventual
worker benchmark; the performance target is still unmet. Typechecks/tests ran
during warmup before the final-1000 profiling window, not during that window.
The control process also exited normally and closed its workers.

## Tests and remaining work

86 tests across ten files passed, including both map layouts, every mutation
kind, edge chunks, subscriptions/disposal, rollover and existing planner/order/
pacing regressions. Whole-project tsc has only the two known missing .mjs
declarations in IdleDevSupervisor.test.ts and IdleExpoProxy.test.ts; it is not
a green whole-project build.

Next: lightweight attack/queue mutation stamps, coherent bounded shared-memory
workers, ordered validated application and measured serial application cost.
Keep exact replay comparison as the oracle, including conflicting attacks,
fallout, configuration changes, fog fallback and mature fleets. The present
no-fog early expansion coverage does not establish later-game correctness or
performance. Finally run paced delivery and live-device checks against the
unchanged <=100 ms p99 / steady 10 TPS goal.

Reproduction uses IDLE_BENCH_ATTACK_SHADOW=1, IDLE_BENCH_SHADOW_KERNEL=1,
IDLE_BENCH_SHADOW_AHEAD=1 and IDLE_BENCH_SHADOW_REVISIONS=8. For the comparative
run set IDLE_BENCH_SHADOW_REVISION_COMPARISONS=4; profile from 1200 and run
the frozen 6xoPucFs input with optimized 2200. Use a new output filename and
no active user world. Live-game guards remain installed in the replay harness.
