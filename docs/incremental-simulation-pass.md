# Incremental simulation work — first measured pass

## Implemented

- TileSet uses one probe sequence for common insertions, preserving insertion order, tombstones and live-iterator semantics.
- Traversal generation stamps use sparse linear 4096-tile blocks, avoiding spatial page coordinate lookup/object allocation for every mark and membership check.
- Attack candidate processing decodes terrain once instead of separately querying water, impassability and terrain class. Candidate order and RNG calls are unchanged.
- Water source/target-to-graph-node resolution has a bounded 4096-entry cache. The cache belongs to the resolver; WaterManager replaces that resolver whenever it rebuilds connectivity.

The existing attack frontier already grows incrementally. Border maintenance already visits only the changed tile and its four neighbors. Candidate deduplication or different frontier refresh timing is NOT safe without preserving RNG, heap ordering and all same-tick dependencies.

## Verification

36 targeted tests pass (attack behavior, native-Set parity, traversal generation rollover, graph-cache replacement). TypeScript check passes.

Identical 1200-tick, 2000-bot Pixel Earth 27x fixtures produced the same SHA-256 digest across streamed deterministic update contents:

`a78d9629bfcb7d47ecf0bb935f3414d6cc354f5b09eca8395d40d0aaa3dbb4fb`

Baseline `.data/incremental-baseline.json`: mean 49.36 ms, p95 79.38 ms.
Final `.data/incremental-final.json`: mean 45.43 ms, p95 64.25 ms.

These are single-run samples on a shared machine, not statistically controlled performance guarantees. The fixture retains its historical 15x attack divisor, not the current new-world 1x setting. It has no mature trade/train fleet. Digest comparison covers emitted updates and ownership deltas, not every hidden execution field. Reported snapshot-record timing also includes digest overhead when IDLE_BENCH_PARITY=1.

No backend restart was performed; existing worker instances remain unchanged. Newly created simulation workers load the changed engine code. Existing journal recovery must remain compatible; broader recorded-human-input parity tests remain necessary before production deployment.

## Remaining work — NOT implemented

1. Profile representative normal-speed, mature-world inputs, with before/after replay hashes and repeated timing samples.
2. Introduce versioned immutable read jobs with a bounded worker queue, shared read-only terrain, stable job IDs and ordered commit. A worker must never mutate authoritative state. Reject/fallback stale results. Cap total workers and outstanding shared buffers per host, not per world.
3. First offload independently verifiable derived work. Existing synchronous pathfinding cannot be moved across ticks without accounting for simulation dependencies; a generic unused worker-pool class is not a completed optimization.
4. Only parallelize regional mutation once a dependency/conflict model demonstrates equivalence across worker counts. Player-wide resources, RNG order, attacks crossing boundaries and graph invalidation must retain existing semantics.

No regional ownership or worker-pool execution is enabled by this pass. Combat, targeting, economy, AI and rendering rules are unchanged.
