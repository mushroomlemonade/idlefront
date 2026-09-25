# Rail tail-latency pass — 2026-09-10

User priority: **p99 within the 100 ms budget**, not just a better mean.
Goal remains active pending recurring-tail and large-world delivery evidence.

## Aligned evidence

`fast-fame-spike-aligned.json` / `.cpuprofile` replay 13,050 frozen Fast fame
turns; profiling starts at 12,500. The report includes monotonic clock alignment
and separate navigation, core execution and snapshot boundaries per tick.
`summarize-cpu-profile.mjs PROFILE REPORT TURN` clips samples to one exact tick.

At turn **12920**:

- Total 1487.090 ms, navigation preparation 14.354 ms, simulation execution
  1472.677 ms, snapshot 0.060 ms.
- Train-station connection work: 94.32% of sampled tick duration.
- Rail A* chain: 92.56%; generic A* itself: 91.00% inclusive.
- GC 2.63%; idle/wait 0.71%. This is a reproducible CPU-heavy rail search,
  not evidence of a slow snapshot or worker-pool wait.

Other over-budget ticks in this window include both simulation-heavy and
navigation-heavy cases. Fixing rail alone is not presumed to solve every p99
violation or delivery jitter.

## Implementation

- Reuse one rail search per minimap, preserving independent path steppers.
- Build conservative **weak connected components** of the rail adapter's
  directed graph. A disconnected pair cannot have a directed route, so reject
  it without a global A* search. A connected pair still runs the exact search.
- Terrain observers union newly possible edges locally. Removed edges may
  remain in the conservative index: this can reduce filtering effectiveness,
  but cannot incorrectly reject a newly valid route. The real search reads
  current terrain. No whole-map rebuilding is inserted into live ticks.
- The component index uses five bytes per minimap node, capped at 64 million
  nodes (320 MB decimal); above that, or for maps without terrain notifications,
  use the exact search without this precheck. It is not an unlimited-scale
  component architecture. Many destructive terrain changes can gradually make
  the conservative precheck less selective.
- Keep existing dense A* for up to four million nodes (64 MB search records).
  Larger worlds use `SparseAStar`, whose records grow with visited nodes, not
  world area. Same neighbors, costs, integer storage, LIFO bucket ties, parent
  behavior and 500,000-iteration cutoff. No route-quality/rules tradeoff.
- The host prepares the reusable rail index before the first simulation tick.
  Browser rendering is unchanged; this does not make map initialization free.

## Validation before full replay

- Randomized exact-path comparisons on classic and paged maps, including
  impassable sinks, multi-source order, terrain conversion, shoreline edits,
  packed terrain updates, and iteration cutoffs.
- New-island connection regression: a previously rejected route becomes
  available immediately after terrain changes.
- Sparse records do not allocate an array sized to a 200-million-node adapter
  for a two-node search.
- 195 tests passed across 25 files, including simulation/rejoin and water-nuke
  coverage. Typecheck still reports only the two pre-existing missing script
  declarations in idle-dev-supervisor / idle-expo-proxy tests.
- Synthetic 12-query disconnected-region batch: 130.690 ms -> 0.0075 ms after
  ~13.1 ms one-time preparation. This is not a whole-game speedup claim.
- The first sparse-only candidate made tiny connected searches slower; retain
  the dense search on small maps rather than impose that tradeoff everywhere.

## Completed full replay

`fast-fame-rail-indexed.json` completed all 15,647 frozen turns, with clock-aligned
profiling from turn 12500. All **156 checkpoints and the final gameplay update
hash match** `fast-fame-mature-indexed.json`:
`9ec3d88f88b4fc87f6bc9c22652d40a8d6f653378c61ca8b423f43ced2e28252`.
2354 rail queries; 419 rejected as disconnected before A*.

| Metric, last 1000 turns | Before rail pass | After |
| --- | ---: | ---: |
| Mean | 46.792 ms | 47.321 ms |
| p99 | 140.275 ms | **93.708 ms** |
| Maximum | 282.297 ms | 213.142 ms |
| Turns over 100 ms | 16 | 9 |

This is a **tail improvement, not a mean-throughput improvement**. Turn 12920
dropped from 1437.609 ms (1487.090 ms in the aligned diagnostic repeat) to
**43.425 ms**. Turn 15156 dropped from 217.115 ms to 30.049 ms.
Great Lakes late-window compute meets the p99 gate in this recording. This
does NOT prove large-world or network-delivery p99, nor eliminate all outliers.

Residual aligned evidence, for the next pass:

- Turn 14642: 393.246 ms; 82.63% still rail-station connection searches. The
  weak-component filter does not reject long detours within one component.
  Existing rail maximum length is `110 * 1.4142` full-resolution tiles. A
  conservative local reachability bound at the **connection consumer** (not
  changing general rail path semantics) may avoid searches for tracks which
  would already be discarded as too long. Preserve exact successful routes.
- Turn 15048: 213.142 ms; UnitImpl.delete self samples 55.32%. Repeated roster
  filtering when many ships/trains finish together remains a likely O(n*k)
  batch cost. An ordered roster with lazy array snapshots could make removal
  O(1), but must preserve the old iteration/add/remove snapshot semantics.
- Turn 14702: 163.530 ms; NationExecution is 68.75% inclusive, primarily
  `closestTwoTiles` / `closestTile` in execution/Util.ts. Preserve tie order if
  replacing that nearest-border search with an index.
- Full replay maximum is now initial turn 2 (~1158 ms); startup still differs
  from sustained tick performance and must not be silently omitted.

No active persistent user games were present. The benchmark workers closed at
completion. No backend restart or production push was performed. Goal remains
active: proceed to large-world, recurring-tail and paced-delivery validation.
