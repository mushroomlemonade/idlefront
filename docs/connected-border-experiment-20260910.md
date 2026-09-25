# Connected border certificate — rejected

The prototype kept a conservative eight-neighbor connectivity certificate on
the border TileSet. Attached additions retained it; deletions retained it only
when the remaining local neighbors connected without the deleted vertex (all
256 local masks checked). Uncertain edits fell back to the original DFS.
Skipping capture logic additionally required a current ocean/map-edge/unowned
neighbor witness and an exact bounding box of the sole component. No gameplay
cadence, resource, traversal-order or capture rule was changed.

Tests passed exhaustive local masks, every small-world single edit, random
edits in linear and paged layouts, and actual scripted ownership/capture/bounds
comparisons. The 27x 2200-turn frozen replay matched all gameplay output hashes.
Nevertheless the runtime change was **removed**, along with its prototype-only
helper and tests. The capture/bounding-box regression coverage remains.

## Whole-world result

Report: `.dev-logs/profiles/27x-expansion-connected-borders.json` and CPU profile.
Same 1200–2200 profile window and input as the previous known-absent insertion.

| Last 1000 ticks | Previous retained | Certificate prototype |
| --- | ---: | ---: |
| Mean compute | 92.841 ms | 97.330 ms |
| p99 compute | 118.033 ms | 129.116 ms |
| Maximum | 140.062 ms | 205.075 ms |
| Over 100 ms | 170 | 351 |

Hash: `0d92157e9b86dfd5cc23c1751db5b7f84189ace42be423c5f67a5476be230d71`.
The profile spent ~5.3% self time in the specialized border deletion and still
~12% inclusive in removeClusters. Maintenance outweighed the walks avoided.
This is not an optimization to ship merely because the proof was correct.

No live worlds were active; no server restart, production push or journal
deletion was performed. The benchmark process terminated and its workers closed.

## Follow-up: exclusive ownership index — also rejected

An exclusive ownership-roster index avoids a separate hash table for every
country. A tile belongs to exactly one such roster; conquest already removes
the old entry before inserting the new one. The shared, lazily paged index
stores each tile's dense position, checked against the queried roster's dense
tile to reject another owner's entry. Borders and attack sets remain unchanged.
Ordering, same-owner reconquest, compaction and live iteration remain exact.

The prototype was opt-in (`IDLE_EXCLUSIVE_TILES=1`) in the Node map loader only.
Maximum possible page allocation had to fit min(1 GiB, total RAM / 8,
available RAM - 2 GiB); otherwise ordinary TileSet remained in use. Browser
simulation was unchanged. It was never enabled for the live dev server.

The local tests passed 15,000 mixed ownership edits, duplicate rejection,
tile zero, page boundaries/high tile references, same-owner reconquest,
cross-roster ownership transfer, compaction/position/revision/iterator equality,
and actual capture comparisons. The initial exhaustive test timed out because
it made 1.2 million individual assertion calls; batching the same membership
comparisons made it pass within the default timeout without reducing coverage.

Both complete replay variants matched all 22 checkpoints. Reserving the small
page-directory array (~422 KiB for this map) prevented sparse JS directory
growth, but did not make the result better than the original storage.

| Last 1000 ticks | Original sparse directory | Reserved directory | Fresh hash control |
| --- | ---: | ---: | ---: |
| Mean | 96.471 ms | 96.139 ms | 92.832 ms |
| p99 | 145.666 ms | 125.950 ms | 121.929 ms |
| Maximum | 200.675 ms | 167.982 ms | 156.394 ms |
| Over 100 ms | 313 | 302 | 177 |
| Peak RSS | 3299 MiB | 3306 MiB | 3181 MiB |

Reports: `27x-expansion-exclusive-tiles.json`,
`27x-expansion-exclusive-directory.json`,
`27x-expansion-hash-control-sept11.json` in `.dev-logs/profiles`.
All used the same frozen 2200 turns / final-1000 CPU-profile window,
sequentially, without an active persistent world. The control also matches
the earlier retained mean (92.841 ms), supporting rejection rather than
attributing the slower result solely to changed machine load.

The index, Node opt-in, PlayerImpl integration and prototype-specific tests
have been removed. Ordinary TileSet is restored. Additional capture and exact
bounding-box regression tests remain. No gameplay optimization from this
experiment is represented as a shipped improvement.

## Accounting follow-up

Read-only inspection identified QEMU Virtual CPU version 2.5+, 12 virtual
cores at a reported 3600 MHz, and Windows Balanced power policy. This does
**not** establish hypervisor contention or justify changing host configuration.

The replay harness now optionally records `process.threadCpuUsage()` around
each measured tick (`IDLE_BENCH_CPU_ACCOUNTING=1`). It separates OS-accounted
simulation-thread CPU from wall time. Windows accounting can be coarse;
wall-minus-CPU can include waits, other-thread GC and OS scheduling and is NOT
a direct measurement of hypervisor steal. Navigation workers are not included
in thread CPU. The measurements do not enter the gameplay digest.

### Accounting result (retained simulation code)

`27x-expansion-cpu-accounting-sept11.json` completed all 2200 turns with the
same hash and all 22 checkpoints. Last 1000 wall-time mean **92.471 ms**,
p99 **116.815 ms**, maximum **144.501 ms**, 160 ticks over 100 ms. Charged
thread CPU averaged **90.964 ms**. Mean wall minus charged CPU was **1.507 ms**.
The slowest tick (2089) charged **141 ms CPU** for **144.501 ms wall time**.
CPU values are quantized (e.g. 94, 109, 125, 141 ms), so do not interpret a
negative individual wall-minus-CPU difference as impossible execution or
the CPU p99 (125 ms) as a precise independent latency percentile.

This supports concentrating on actual simulation work; it does not support
blaming the observed replay tail primarily on idle waiting or VM scheduling.
Turn 2089's aligned sampled profile attributed ~82 ms inclusive to attack
execution and ~22 ms to cluster removal. Navigation was 0.020 ms and snapshot
recording 0.343 ms. Inclusive times overlap and must not be added indiscriminately.

After restoring the simulation code, 17 tests across six files passed.
No replay workers remain running. Whole-project typecheck still has the two
pre-existing missing declarations for the idle supervisor/proxy test imports.
No new paced-delivery run was warranted: neither proposed runtime optimization
survived its compute gate. The previous measured paced p99 remains ~140 ms
compute / ~150 ms delivery, not the 117 ms unpaced accounting run.

### Next evidence-directed action

Inspect stale entries in the attack priority heap. The current dequeue loop
checks four-neighbor adjacency before rejecting a tile whose owner no longer
matches the target. Moving that pure owner rejection ahead of the adjacency
scan could avoid repeated work for already-conquered heap entries without
deduplicating the heap, changing ties, consuming different random numbers,
or altering attack-border removal. This is NOT the previously rejected
terrain/owner reordering in addNeighbors. Validate exact replay hashes and
paired timings before retaining it. For larger structural gains, any frontier
replacement must preserve the heap's duplicate/tie behavior; naïve deduplication
can change conquest order and is not authorized as a performance shortcut.
