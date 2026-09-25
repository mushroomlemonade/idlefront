# Wilderness shadow planner: first correctness gate passed

Follow-up: `wilderness-kernel-ahead-20260911.md` records the lower-overhead kernel
and measured start-of-tick conflict coverage. Both remain shadow-only.

## Implemented, not enabled in live games

- `PseudoRandom.snapshot/fromSnapshot` copies all four signed sfc32 state
  words without consuming draws. Heap snapshots preserve internal heap order,
  duplicate tiles, Float32 priority bits and capacity; they are restored
  directly, not rebuilt by re-enqueueing (which could change ties).
- `AttackImpl.borderSnapshot` and `AttackExecution.wildernessPlanningInput`
  expose detached planning data only for supported active wilderness attacks.
  A pure `hasAttackActivityPolicy` check avoids calling the stateful fog budget
  twice. Fog, installed activity policies, non-default combat overrides,
  inactive/retreating attacks and player targets are not eligible.
- `WildernessAttackPlanner` reuses the actual attack tick against guarded,
  read-only capabilities and a local ownership/fallout overlay. It records
  ordered border, troop and conquest effects. Unknown capabilities and
  terminal/refill paths explicitly fall back. Unexpected errors propagate.
  **There is no plan-commit API and no live worker execution yet.**
- The replay-only `ShadowAttackVerifier` samples wilderness calls, calculates
  a plan, then runs the original authoritative tick and compares every effect,
  final attack state, heap and PRNG state. The original code is always the
  sole writer. All wrappers and the territory observer are removed at completion.

## Recorded-world result

Report: `.dev-logs/profiles/27x-wilderness-shadow.json`.
Input: `6xoPucFs-replay-20260910.json`, first 2200 turns, 27x Earth,
216,086,656 tiles, unchanged rules/inputs.

| Counter | Result |
| --- | ---: |
| Wilderness calls considered | 2,412,760 |
| Sampling stride | 32 |
| Sampled calls | 75,398 |
| Verified plans | **73,556** |
| Ineligible snapshots | 489 |
| Terminal-attack fallbacks | 1,277 |
| Exhausted-frontier fallbacks | 76 |
| Mismatches | **0** |
| Largest read-tile set | 2,592 tiles |
| Largest effect list | 2,354 effects |

Every one of the 22 rolling checkpoints matched the retained reference.
Final gameplay hash:
`0d92157e9b86dfd5cc23c1751db5b7f84189ace42be423c5f67a5476be230d71`.

Across sampled calls, input snapshot data totaled 272,096,720 bytes. Measured
snapshot time was 728.6 ms; planning 17,731.8 ms; comparison 3,675.0 ms; the
selected original ticks totaled 4,617.3 ms. These are **diagnostic totals**, not
worker throughput estimates. The guard/proxy implementation is expensive and
shares the original function with different receiver shapes, which can affect
JIT optimization. The diagnostic final-1000 mean was 156.5 ms versus roughly
93 ms normally. Do not ship this wrapper or call this a speedup.

## Tests and known limitations

39 tests across seven files passed: RNG/heap checkpoints (including duplicate
Float32 ties and high tile refs), no real-map mutation, exact effects/final
state over multiple turns in both map layouts, changing fallout counts,
third-party borders/terrain obstacles, custom-config/policy rejection,
stateful-policy counters not called, terminal/refill fallback, unknown future
capability fallback, retreat rejection, attacks and pacing regressions.

The first fallout fixture tried to mark already-owned land and was rejected
by the existing engine invariant. It was corrected to mark unowned land; no
engine rules were relaxed to make the fixture pass.

Read tiles are currently addresses, **not a coherent versioned worker read
set**. A production planner must also validate relevant global scalars (e.g.
fallout count / land count when used), attack/PRNG/heap identity, policy and
configuration at the original execution position. Copying input at the start
of a tick is insufficient if earlier executions change a dependency.

The next gate is a lower-overhead computational implementation and measured
worker transport/application costs. Consider batching, compact effect buffers,
shared bounded world storage, and isolation from the main thread's JIT.
Do not assume the guarded planner can simply be moved to workers and meet the
100 ms p99 target. Full shared-state conflict validation, actual application,
fog support/fallback behavior, mature-world replay and paced delivery tests
remain outstanding. The goal remains active and unachieved.

No active game was interrupted, no server was restarted, and no production
push was performed. The shadow benchmark process completed and closed its
workers. The live code path does not call the new planning APIs.
