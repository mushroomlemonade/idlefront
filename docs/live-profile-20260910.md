# September 10: live profiling and pending performance fixes

## Deployment status

The running Trademaxxing simulation (`Hg34JJFj`, world `world_Hw251inHljnar7Lb`)
was **not restarted**. Backend optimizations below are source changes, tested but
not loaded into that worker. User approval for a coordinated restart/recovery
was requested. Do not claim a live 10 TPS result yet.

The client camera fix is served by Vite: only initial loading may fit the whole
map. Live backlogs and later fog reveals must not reset the player's zoom.

## Evidence

Loopback-only V8 sampling, no debugger pauses; inspector closed after sampling.
Profiles are in `.dev-logs/profiles` (not committed):

- Opening Trademaxxing: `Hg34JJFj-1789078413836.cpuprofile`, 20.159 s.
  Border cluster calculation: 1.465 s inclusive; attacks: 1.731 s inclusive.
- Developed Trademaxxing: `Hg34JJFj-1789079042737.cpuprofile`, 20.204 s.
  Idle 7.439 s. Water-pathfinder chain 5.635 s inclusive, approximately 44% of
  non-idle sampled time. Full-resolution water repair alone 4.489 s inclusive.
  Cluster calculation 1.355 s; attacks 1.819 s inclusive.
- Older developed world `iFGQu9SP-1789075544714.cpuprofile`: routing likewise
  dominant; parent `parent-11568-1789075597544.cpuprofile` spent 31% of sampled
  wall time in synchronous output writes. Repetitive route messages flooded logs.

Inclusive categories overlap; do not add them together. Opening and developed
world profiles are NOT a controlled before/after comparison. Old-world retirement
did not by itself establish the desired live TPS.

## Changes prepared

1. Border DFS uses one generation stamp for "border member and unvisited" instead
   of a hash membership lookup plus visited lookup for every neighbor. Same
   component order, tile order, eight-neighbor topology, capture cadence and rules.
   Synthetic paged-map median times (10 calls/sample, 5 measured samples):
   - fragmented 65,536 borders: 60.72 -> 10.43 ms (5.82x)
   - long fronts 32,512 borders: 6.66 -> 3.10 ms (2.15x)
   - dense 65,536 borders: 8.68 -> 7.17 ms (1.21x)
   These are component microbenchmarks, not whole-world speedups.
2. Bounded exact failed-water-route cache, 4,096 keys per chain. Single-source
   failures only; moving endpoints, multiple sources, successful routes and
   exceptions still invoke existing routing. Invalidates on actual water
   conversions (before delayed graph rebuild) AND graph-version changes. No
   shortened paths, changed trade destinations, or changed ship rules.
   Synthetic blocked journey, 30 identical retries: 81.25 -> 2.66 ms, one search
   plus 29 hits. Actual live hit rate remains unmeasured; diverse routes may gain
   little. Diagnostic counters expose searches/hits/invalidations.
3. Rate-limit identical route diagnostics to one message per 10 seconds with a
   suppressed-repeat count. No pathfinding or simulation decisions use the clock.
4. Catchup camera only fits initial load, not a conquest-induced update backlog.

## Validation

- 58 tests passed across 11 focused suites (water routing, stepper, traversal,
  ownership, trade ships, camera and diagnostics).
- Additional 160-tick scripted baseline/optimized comparison passed: player
  hashes, tile ownership, and structure ownership/counts match every tick.
- Randomized border tests compare exact ordered components over 150 edit rounds
  on both classic and paged maps, including generation wrap and diagonal edges.
- Typecheck reports two pre-existing missing `.mjs` declarations in startup/proxy
  test imports; no new errors appeared at the time checked. Recheck after edits.

## Retired older worlds, authorized by user

Finished database records for `world_nlQq0ClgPhUHSIed` / `iFGQu9SP` and
`world_Ft32qy49TYcnTCGb` / `coHfCmuH`. The iFGQu9SP simulation thread was stopped
explicitly after verifying its identity; Trademaxxing's thread was preserved.
The other cluster worker had no attached simulation threads. Journals retained.
Backup: `.data/backups/before-september10-retirement-1789078870328.sqlite`.

## Rejoin observation / next step

Server accepted repeated rejoin requests and prepared snapshots (15.8 MB, later
20.9 MB). It subsequently reported one streaming viewer, interspersed with
disconnects. This does not prove the client finished rendering; a user status
question is outstanding. Vite changes can cause reloads. Avoid more unnecessary
client edits while obtaining a stable reproduction.

After coordinated backend restart, verify journal recovery, same player seat,
and exact gameplay behavior. Profile developed-world routing again, inspect cache
hit counters, and measure actual ticks/wall time and tail latency. If route misses
remain dominant, optimize full-resolution repair scratch and corridor generation
with differential route tests before considering worker-pool architecture.
Major restructuring requires discussing scope with the user first.

## Tail-latency follow-up (same evening)

Goal: steadily delivered 10 TPS (100 ms/tick), not merely a favorable mean.
`scripts/live-tick-cadence.mjs` installed a bounded 4,096-row Float64 buffer in the
existing worker's outgoing message path. It records completion interval, worker
duration, core duration and encoding time, without changing turns or pausing the
debugger. Inspectors are still loopback-only and closed after each capture.

The first 517 intervals had median 323 ms, p95 624 ms, p99 798 ms and maximum
1,001 ms. This window overlapped development tests; do not treat it as an isolated
hardware capacity benchmark. Later samples confirm similar or worse spikes.

Clock-aligned profile `Hg34JJFj-1789079890918.cpuprofile` and cadence
`Hg34JJFj-cadence-1789079908809.json` isolate sampled work during ticks >=500 ms:
50.6% full-resolution water repair, 15.4% other pathfinding, 11.2% attacks,
6.3% player/cluster work, 3.3% GC. Categories are disjoint. 13 slow ticks were
covered; this is attribution of sampled slow ticks, not a long-duration SLA.
Reproduce with `scripts/analyze-tick-spikes.mjs PROFILE CADENCE`.

New prepared optimization: `WaterRepairSearch` replaces three per-search hash
collections with one tile-to-index map plus reusable typed records and a typed
binary heap. Corridor expansion is once per distinct 16x16 center block instead
of once per route point. Heap tie-breaking, neighbor order, source order,
endpoint exceptions and 200,000-expansion cutoff remain unchanged.

Controlled 12-destination repair benchmarks (median of five batches):
- blocked: 129.71 -> 71.89 ms (1.80x)
- legal detour: 74.76 -> 40.92 ms (1.83x)
- many blocks: 129.89 -> 71.67 ms (1.81x)
These bypass the failed-route cache, so they also address unique destinations.
Differential tests compare exact paths/null results on classic and paged maps,
terrain changes, duplicate multi-sources, buffer growth, and the search cutoff.

### Live intervention: route diagnostics ONLY

Parent profile `parent-11568-1789080044132.cpuprofile` measured **53.9%** wall
sample time in worker stdout/stderr forwarding to synchronous disk writes.
At worker performance time **17651128.682 ms** (wall 1789080127952), applied a
live limiter to exactly two one-argument messages via console.warn/log:
`captured trade ship cannot find route` and `path not found to target`.
All other diagnostics pass through unchanged. This duplicates the prepared
source fix and disappears on restart. The worker retains original console
methods at `globalThis.__idlefrontRouteLogLimit.originals` for recovery.
No simulation algorithm, journal, intent, or worker process was changed.

Adjacent windows in `Hg34JJFj-cadence-1789080183041.json`:
- Before: 122 intervals, mean interval 492.30 ms; mean between-turn gap 135.45 ms,
  median gap 126.37 ms, p95 gap 304.31 ms.
- After (excludes first 10 seconds): 119 intervals, mean interval 376.72 ms;
  mean gap 7.23 ms, median gap 1.20 ms, p95 gap 27.28 ms.
- 563 matching messages observed, 551 suppressed.
- Throughput approximately 2.03 -> 2.65 TPS in adjacent live windows. The world
  keeps changing, so not a deterministic A/B benchmark. Core cost did NOT fall;
  route/cluster optimizations are still pending restart. Tail ticks still exceed
  one second, so the 10 TPS goal is **not achieved**.

Run `scripts/compare-live-log-limit.mjs CADENCE` to reproduce. Do not restart the
active Trademaxxing backend until the user answers the pending restart question.

Final validation for this pass: **143 tests passed in 19 suites**. Typecheck has
only the two previously recorded missing `.mjs` declarations. The temporary
cadence wrapper was removed after 1,601 samples; the live route-log limiter
remains active. Loopback inspector closed. No backend restart, commit, or push.

## Recovery/comparison preparation while awaiting restart approval

Exported actual worker start data and a read-only transaction-consistent journal:
`.dev-logs/profiles/Hg34JJFj-replay-20260910.json`, 436,422 bytes, turns 0–12,554
(12,555 consecutive valid TurnSchema records). SHA-256:
`55351f5bdc924f539d87b5a47e8c8e1fc5eba409bd0e8b119c22d6ba5e5fd58d`.
This is a frozen comparison input, not a substitute for the newer live journal
when actually recovering the user's match. It proves journal integrity at the
export boundary, NOT successful recovery or end-to-end TPS.

`scripts/benchmark-recorded-playtest.ts INPUT OUTPUT baseline|optimized` runs
the frozen inputs without any database or network writes. Baseline mode uses
the saved pre-optimization cluster DFS, water repair and uncached failed routes.
Both modes retain rate-limited diagnostics to avoid a logging confound.
Reports contain every tick's compute duration, p50/p95/p99/max, last-1,000-tick
costs, route-query/failure/cache-hit counters and cumulative deterministic
update hashes every 100 ticks. Times exclude hashing itself; this is compute
headroom, NOT client delivery performance. Run sequentially, not concurrently
with the active large playtest. The `IDLE_BENCH_MAPS_DIR` override is only for
fixture smoke tests; leave it unset for the real frozen playtest.

350-turn small fixture smoke runs passed, baseline and optimized digest both:
`6639515566c2014ea65cb345b1a3f3dc2052a461af05047d7cf7bf0bde6f7397`.
Do not interpret the tiny fixture's speed as large-world capacity. The real
12,555-turn comparison and a live 10 TPS delivery test are still outstanding.

## Authorized restart and Fast fame, September 10 evening

User approved restarting/recovering Trademaxxing. Its workers were gracefully
flushed, leaving 14,723 turns through 14,722. Recovery backups:
`.data/backups/before-optimized-restart-1789081567124.sqlite` and
`.data/backups/after-graceful-stop-1789081634636.sqlite`.
The managed Windows session could not be attached with `_debugProcess`
(`OpenFileMappingW`, error 2); the processes were alive, not crashed. Before
recovery advanced the journal, relaunched the same backend in the interactive
profiling session. Master 7396, w0 9616, w1 1100. Startup supervisor subsequently
resumed monitoring; web/Expo/tunnel remained running.

User then explicitly replaced Trademaxxing with **Fast fame**:
`world__NPBPdQxGvQP3-dA`, game `1zHqb4zj`, Great Lakes, 10x trade/trains,
normal attack pace. Marked Trademaxxing finished, retained its journals, and
verified neither worker process held its large simulation anymore.

The browser play attempt was blocked by Windows browser URL-policy support.
The assistant did NOT join as a second player, and did NOT collect a detailed
profile during the user's completed play session. Only automatic existing
100-tick logs cover that session. Do not imply otherwise.

Automatic log analysis through tick 14,700: 147 samples, overall 9.9765 TPS
between ticks 100 and 14,700. Slowest 100-tick span (12,700–12,800) 7.3643 TPS;
maximum sampled clock debt 11,397.5 ms. Sampled computation p50 57.38 ms,
p95 102.77 ms, maximum 125.19 ms. These are every-100th-tick samples, NOT
every-tick percentiles or worst individual stalls. This is a smaller different
map than Trademaxxing; no controlled before/after speedup claim is supported.
The steady 10 TPS large-world goal remains unverified.

After the user returned, enabled the bounded tick-cadence probe and started a
20-second V8 profile on still-running Fast fame. This is post-playtest capture,
not evidence of what occurred during the user's earlier inputs.

Post-session artifacts:
- `1zHqb4zj-1789083430395.cpuprofile`: 20.19 seconds, water-refinement
  pathfinding 66.6% inclusive wall time, water repair search 47.8% (nested,
  not additive), trade ship execution 68.8% inclusive. Train station execution
  6.2%, GC 2.2%, idle 2.0%. Main remaining hotspot is water routing.
- `1zHqb4zj-cadence-1789083456112.json`: 510 intervals, mean 110.36 ms,
  p50 100.33 ms, p95 202.38 ms, p99 258.11 ms, max 365.68 ms. All with
  zero connected viewers; includes the sampling profiler's overhead.
- `1zHqb4zj-replay-20260910.json`: 15,647 validated consecutive turns,
  540,206 bytes, SHA-256
  `f5cef2ebb570e13f28cbfaf82019d5f02eb3b59822a175c8823b88f297237f70`.

Removed the temporary cadence wrapper after 717 samples and closed inspector.
The game remains running; no further restart or pacing changes in this capture.

## New 27x playtest

User started `world_ly0okZb5Wn9z9BYZ` / `6xoPucFs`, Pixel Earth 27x v1,
5x trade/trains, normal attack pace. Both it and Fast fame still run on w0;
asked permission to retire Fast fame (zero viewers), not yet acted on it.
Attached bounded cadence probe and captured
`6xoPucFs-1789083553322.cpuprofile` (20.11 seconds).
Opening-phase attack execution is 61.5% inclusive wall time; conquer 28.4%,
border updates 17.1%, addNeighbors 19.8% are nested costs, not additive.
Tribe execution 12.3%; border cluster collection 6.2%; GC 0.9%, idle 1.1%.
This differs fundamentally from the older trade-heavy game's routing profile.

`6xoPucFs-cadence-1789083571849.json`: 290 intervals, mean 157.77 ms
(6.34 TPS), p99 286.09 ms, maximum 739.89 ms. Includes competing Fast fame
and profiler overhead; not isolated capacity. Probe remains installed with
bounded rolling capacity 4096 ticks; it is NOT durable whole-session capture.
The sampling profiler finished and its loopback inspector closed.

User approved retiring Fast fame. Marked only `world__NPBPdQxGvQP3-dA`
finished and stopped only its identity-verified `1zHqb4zj` simulation thread at
23:40:26Z; preserved `6xoPucFs`, backend and all journals.
Post-retirement cadence file `6xoPucFs-cadence-1789083689863.json`, filtering
ticks >1854: 318 intervals (1855–2172), 6.7204 TPS, p50 140.16 ms,
p99 321.44 ms, max 343.59 ms, core mean 137.10 ms. No sampling profiler
during this later window. World state changes over time; not a controlled A/B.
Removing the competing world alone does not reach the 100 ms/tick target.
