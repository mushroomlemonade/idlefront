# Territory data-path follow-up

## Rejected cluster candidate

Combined mark-consumption and locally expanded eight-neighbor traversal was
tested against the exact original DFS order. Isolated timings against the
preceding stamped implementation improved 8.311 -> 5.178 ms for 65536 isolated
borders, 2.859 -> 2.285 ms for 32512 long-front borders, and 5.698 -> 5.487 ms for
65536 dense borders. These gains did NOT carry through the full workload.

`27x-expansion-consume-clusters.json`: same final gameplay hash, but last-1000
mean 97.966 ms, p99 129.539 ms versus prior mean 94.762 / p99 119.906 ms.
The candidate was removed from runtime code. Original stamped/callback DFS is
restored. Extra exhaustive small-map/one-row/one-column order tests were kept.
No claim that the isolated improvement solves the real simulation bottleneck.

## Known-absent territory insertion

Conquest removes a tile from the previous owner's territory set before adding
it to the next owner's, including same-owner conquest. The owner map already
establishes uniqueness. `TileSet.addKnownAbsent` skips duplicate comparisons and
can insert at the first reusable tombstone rather than probing to an empty slot.
General `add` remains unchanged; growth/compaction fall back to it. Only the
territory-add site in GameImpl.conquer uses the preconditioned operation.

Tests compare general versus preconditioned insertion through 15000 random
mutations, collisions, tombstones, clear/growth and active iterators. They check
not only values/order/count/revision but the identical backing hash table and
dense slots, so future compaction/probing sees the same layout.
25 tests passed across five files, including border and cluster equivalence.

Isolated 200000-tile benchmark (300000 inserts plus 100000 removals), median of
seven alternating trials: 17.644 -> 13.583 ms. A constant-factor gain, not a
whole-game or asymptotic speedup claim. Full 27x replay validation started:
`.dev-logs/profiles/27x-expansion-known-absent.json`.

That replay completed with the same gameplay hash. Last-1000 mean 92.841 ms,
p99 118.033 ms, max 140.062 ms; 170 ticks over 100 ms versus 258 before this
insertion pass. This improves common-tick cost but does not meet the gate.

## Ownership-first attack filter

`AttackExecution.addNeighbors` now checks the target owner before classifying
terrain. Both are pure reads; ineligible owned/third-party neighbors no longer
need a terrain lookup. Eligible tile traversal, border additions, random draws
and priorities retain the original order. No attack speed, troop-cost or target
changes. A focused test explicitly checks skipped classifications and the exact
random calls/priorities, alongside attack/capture/pacing regressions.

29 tests passed across six files. Typecheck reports only the same pre-existing
missing declarations for the idle-dev-supervisor / idle-expo-proxy script tests.
`.dev-logs/profiles/27x-expansion-owner-first.json` completed with the same
1200–2200 profiling window and no competing benchmark or active user game.
It matched the gameplay hash, but last-1000 mean was 93.336 ms / p99 122.113 ms,
versus 92.841 / 118.033 before. That does not establish an improvement. The
predicate reorder was removed; original attack filtering is restored. The
eligible-priority/random-order regression test remains, without imposing a
particular ordering of pure ownership/terrain reads.

The only retained runtime change in this pass is known-absent tile insertion.
Both hot-loop candidates were rejected on whole-world evidence rather than
kept on plausibility or isolated timing gains.

## Paced retained-change result: mixed, still FAILS

`.dev-logs/profiles/27x-paced-known-absent-two-clients.json`: both consumers
received all 1000 ticks (1201–2200) in order at ~10.004 average TPS. Mean
simulation 94.690 ms versus previous 95.720 ms; over-100 ticks 224 versus 272.
Peak simulation 180.541 ms versus 191.487 ms. Maximum completion debt fell from
1324.308 ms to 565.481 ms (p99 debt 555.030 ms).

However compute p99 **139.539 ms** is worse than the previous **135.407 ms**,
and delivery interval p99 **150.022 / 150.143 ms** is worse than **135.922 /
137.158 ms**. This is NOT a p99 success; retaining the insertion improvement
rests on the isolated, recorded, and paced common-cost/overrun/debt reductions,
not cherry-picking one favorable tail metric. Individual comparisons include
runtime variance; repeat tests remain necessary. Encoding p99 0.652 ms and
enqueue-to-receipt p99 ~19–22 ms still point primarily at simulation work.

After removing the two rejected runtime candidates, 27 tests across seven files
passed again. Typecheck still has only the two existing script-declaration
errors. Benchmark workers finished and closed; servers were not restarted.

## Next structural candidate (subsequently tested and rejected)

Investigate conservative connected-border certificates rather than another
DFS micro-optimization. For a known connected eight-neighbor border graph,
adding an attached vertex preserves connectivity. Removing a vertex cannot
split the graph if its remaining neighbors are connected locally without that
vertex; otherwise invalidate and use the existing full traversal at the normal
scheduled time. Remote islands/uncertain edits must fall back, never guess.

Skipping removeClusters requires more than connectivity: preserve the exact
largest-cluster bounding box, and prove the sole cluster cannot be removed
(e.g. a currently valid unowned-neighbor/ocean/map-edge witness, as in the
original predicates). Diplomacy/attack-dependent cases must use the original
logic. No changed cadence, deferred capture, approximate connectivity or
altered neighbor/component ordering. Measure maintenance overhead per changed
tile; reject if it costs more than the walks avoided. Exhaustive local masks
and randomized edit/state comparisons would be required before full replays.

No active user games, server restarts, production push, or journal deletion.
The p99 <=100 ms steady-10-TPS objective remains active and unachieved.

Follow-up evidence is in `docs/connected-border-experiment-20260910.md`.
Both the connectivity certificate and an exclusive ownership index preserved
the recorded gameplay but regressed whole-world timing and were removed.
A fresh retained-code control measured mean 92.832 ms / p99 121.929 ms.
These are unpaced replay compute measurements, not a new live delivery result.
