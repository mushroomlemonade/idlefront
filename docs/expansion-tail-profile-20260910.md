# 27x expansion tail profile and coastline work

Target remains p99 <= 100 ms, including steady delivery; average TPS is not a
pass. No user games were active before the isolated recorded replays. The
benchmark guards stop their own workers if a new active world appears.

## Current workload evidence

`27x-expansion-current-profile.json` replays frozen 6xoPucFs through 2200, with
CPU profiling and aligned phase clocks from 1200. Final hash matches the earlier
27x runs: `0d92157e9b86dfd5cc23c1751db5b7f84189ace42be423c5f67a5476be230d71`.
Last 1000 mean 94.478 ms, p99 125.027 ms, max 192.879 ms. This isolated recorded
run is distinct from the previous compressed paced run (155 ms compute p99).
Do not conflate the two harnesses or attribute that difference without evidence.

Whole profiled window inclusive time: AttackExecution.tick ~57%,
PlayerExecution.removeClusters ~14%. Self time includes addNeighbors ~14.5%,
AttackExecution.tick ~13.9%, TileSet.add ~10.5%; GC ~1.3%.
Inclusive percentages overlap and must not be added as independent costs.

Worst profiled tick 2163: 192.879 ms, ~0.026 ms navigation, 192.411 ms core,
0.442 ms snapshot. SharedWaterCache.build accounts for ~34 ms (~18%), attacks
~72 ms, cluster removal ~32 ms. No large water-worker wait explains this tick.

## Coastal index candidate

SharedWaterCache retains its existing 30-tick refresh, player traversal,
embargo checks and output membership/order. CoastalBorderIndex seeds owned
shoreline candidates once per queried player, then updates them on ownership
and terrain events. Each inland ownership change incurs one shore check;
refresh scans/sorts coastal candidates instead of every inland border tile.
Border membership is still checked; order uses TileSet's current insertion
positions. Unobserved/custom maps use the original scan fallback.

`27x-expansion-coast-index.json` matches all 22 checkpoints and the final hash.
Last 1000 mean 95.339 ms, p99 119.405 ms, max 161.969 ms. Over-100 count went
from 226 to 275; **not a mean-throughput or all-tick improvement claim**.
Tick 2163 dropped to 115.059 ms, with the shared-water build sampled at ~18 ms.
Single-run differences elsewhere can include runtime noise; do not attribute
all improvement to the index. 78 targeted tests passed across seven files.

## Exact component memo follow-up

WaterManager.getWaterComponent repeats minimap projection and up-to-two-hop
water searches for the same full-resolution tile. A per-manager exact memo
stores number/null results, capped at 65,536 entries. It clears on every minimap
terrain edit and on graph replacement. Maps without terrain notifications and
disabled navigation retain the uncached behavior. No alternate path search,
changed neighbor order, modified lake identity or refresh cadence.

`27x-expansion-coast-memo.json` completed with all 22 checkpoints and the same
final gameplay hash. Last 1000 mean 94.762 ms, p99 119.906 ms, max 136.329 ms;
258 ticks over 100 ms. The extra memo does not establish a p99 improvement over
coast indexing alone; the full combined pass reduces peak latency but leaves
the steady compute budget too tight. Tick 2163 is 118.303 ms. Current slowest
window ticks: 1563 136.329 ms, 2103 130.637 ms, 1560 129.114 ms.

104 tests passed across 11 files: component equivalence on both map layouts,
null-result invalidation, the 65,536-entry memory cap, coast ordering/mutations,
unchanged diplomacy/TTL, water nukes, ports, AI construction, routes and workers.
Typecheck caught two test calls to GameImpl-only relinquish; corrected them to
use the public Player.relinquish API. Those three tests were rerun and passed.
Final typecheck reports only the two pre-existing missing declarations for
idle-dev-supervisor.mjs / idle-expo-proxy.mjs; no new type errors remain.

The compressed two-consumer paced repeat completed independently after those
tests, `.dev-logs/profiles/27x-paced-coastal-two-clients.json`.
The overall steady-10-TPS goal remains unachieved. No production push or backend
restart; no active user games deleted. Next large cost: attack expansion (~57%)
and exact border-cluster traversal (~14%), not shader work or network encoding.

## Paced result: improved, still FAILS

| Same 1201–2200 window, two compressed loopback clients | Before | After |
| --- | ---: | ---: |
| Mean simulation | 95.937 ms | 95.720 ms |
| p99 simulation | 155.069 ms | 135.407 ms |
| Maximum simulation | 277.853 ms | 191.487 ms |
| p99 receipt interval, client 1 | 158.312 ms | 135.922 ms |
| p99 receipt interval, client 2 | 158.453 ms | 137.158 ms |
| p99 completion lateness | 1595.296 ms | 1285.930 ms |

All 1000 updates arrived in order on both clients at ~10.006 average TPS.
Core p99 132.065 ms, encoding p99 0.575 ms, enqueue-to-receipt p99 ~20–21 ms.
Temporary schedule debt remains ~1.3 seconds; average throughput is misleading.
This is one before/after paced comparison, not a statistically established
bound. No internet/phone rendering was measured. Benchmark workers closed at
completion and no user games were active.

Next profiled bottleneck: tick 1563 still spends ~61 ms in attacks, ~21 ms in
TileSet.add inclusive samples, ~15 ms in cluster removal, and ~26 ms in AI
construction. Preserve insertion order, traversal, target selection and all
random calls when changing those data structures. The raw frame delays need
more compute headroom; do not reset deadlines, cut bot rules or hide pauses.
