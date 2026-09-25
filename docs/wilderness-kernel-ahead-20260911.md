# Wilderness planning: isolated kernel and same-tick conflicts

## Status

Progress toward exact parallel attack execution, **not a live speedup**.
No server restart, production push, gameplay change, or new live execution path.
Acceptance remains compute p99 <=100 ms and steady 10 TPS delivery.

## Isolated kernel

WildernessAttackKernel implements the eligible wilderness loop with local state,
without calling authoritative AttackExecution methods using a Proxy receiver.
It retains the original heap, Float32 ties/duplicates, PRNG, cardinal order and
interleaved border/troop/conquest effects. Config remains the source of pacing
and troop-loss formulas; small guarded facades reject unmodeled capabilities.
Unsupported configuration, policies, retreat and terminal/refill paths fall back.
There is no authoritative commit API.

Report `.dev-logs/profiles/27x-wilderness-kernel-shadow.json`:

- Same 2200-turn, 216,086,656-tile replay and every-32nd sampling as before:
  75,398 samples; **73,556 verified**, 489 ineligible, 1277 terminal and 76
  frontier-exhausted fallbacks; no mismatches.
- Planning **6403.4 ms**, versus **17731.8 ms** for the guarded reference
  (about 64% less measured diagnostic planning work).
- Selected original ticks totaled 2841.2 ms, including authoritative conquest
  and instrumentation. The planner is still more expensive than those original
  ticks; replacing them serially would not help.
- Diagnostic last-1000 mean 109.13 ms, p99 162.51 ms. NOT live/acceptance numbers:
  original work, planning and comparisons all execute in the same process.

## Start-of-tick feasibility

ShadowAttackVerifier optionally prepares sampled attacks at the start of
GameImpl.executeNextTick, before authoritative executions. At each attack's
original position it checks exact attack state, tick, config, global terrain
scalars and every read tile. Only unchanged plans are compared against the
real tick. Conflicts execute normally. No plan ever writes authoritative state.

WildernessShadowDependencies is diagnostic-only. It captures values while the
authority is paused; read addresses alone are not coherent worker snapshots.
It conservatively includes terrain/fallout flags and global scalars. Deep
state/config comparison and per-tile reads are correctness instruments, not
a proposed production hot path.

Report `.dev-logs/profiles/27x-wilderness-kernel-ahead-shadow.json`:

| Result | Count |
| --- | ---: |
| Samples | 75,398 |
| Prepared nonterminal plans | 73,572 |
| Valid at original execution position, exactly verified | **70,332 (95.6%)** |
| Conflicting tile state, normal fallback | 3,240 |
| Ineligible | 452 |
| Terminal/refill fallback | 1,327 / 47 |
| Prepared but not executed | 0 |
| Verified-plan mismatches | **0** |

Planning 6065.6 ms; dependency capture 3401.0 ms; dependency validation 2378.7 ms;
snapshot capture 535.4 ms; selected original authoritative ticks 2583.9 ms.
Naive validation therefore costs nearly as much as the work considered for
replacement. It cannot simply be added live. Dependency captures totaled
129,187,692 bytes across all samples (not peak RAM).

Both reports match all 22 rolling checkpoints and final hash:
`0d92157e9b86dfd5cc23c1751db5b7f84189ace42be423c5f67a5476be230d71`.
Both benchmark processes exited normally and closed their navigation workers.
Typechecks ran during pre-1200 warmup, not the profiled final 1000; totals remain
diagnostic, not a controlled throughput comparison.

## Tests

51 tests passed across seven files: both planners, linear/paged maps, fallout,
third-party territory, no world writes, heap/PRNG checkpoints, attack order,
pacing, policy/config rejection, changed-dependency rejection, and accepted/
conflicting ahead plans with wrapper cleanup. An additional matrix compares
both planners for Bot/Nation/Human, pace divisors 1/5/15/200 and seven troop
budgets. No rules were changed to pass tests.

Whole-project tsc still reports the two pre-existing missing declarations for
idle-dev-supervisor.mjs and idle-expo-proxy.mjs; it is not a green project build.

## Next gate

1. Replace deep comparison/per-tile validation with conservative mutation
   revisions, retaining exact-value checks as an oracle. Measure false conflicts
   at multiple spatial chunk sizes. Track ALL ownership/terrain/fallout changes;
   territory-only observers are insufficient.
2. Build a bounded computational pool with shared world bytes, coherent barriers
   and batched compact inputs/results. No whole-world copy per worker or tick.
   Existing navigation workers and this machine's RAM/core budget count.
3. Validate at the original execution position, then apply exact effects through
   the existing authority, preserving observer-visible interleaving. Measure
   serial application separately: conquest is NOT parallelized here.
4. Re-run hashes, mature fleets, fog/fallback paths and paced delivery. The 95.6%
   success rate on early no-fog expansion does not establish mature/fog coverage
   or internet/mobile delivery. Four/eight workers are not assumed to be faster.

## Reproduction

Use separate processes without active user worlds. The replay harness checks
the live DB and stops its workers if a playtest starts.
Set IDLE_BENCH_ATTACK_SHADOW=1 and IDLE_BENCH_SHADOW_KERNEL=1; additionally set
IDLE_BENCH_SHADOW_AHEAD=1 for start-of-tick preparation. Keep stride 32 and
IDLE_BENCH_PROFILE_FROM=1200. Run benchmark-recorded-playtest.ts with the frozen
6xoPucFs input, a NEW report filename, and `optimized 2200`. Without these flags,
shadow machinery is not installed. Live SimulationWorker does not import it.
