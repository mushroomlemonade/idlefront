# September 9 simulation stall investigation

## Evidence

- Runtime VDuRgWXZ logged `Authoritative simulation stopped` after a 30-second request timeout. It later served a snapshot at tick 5430 instead of rejecting entry as a failed simulation.
- Seven old expanded/27x test worlds remained active in persistent storage. Restarting processes alone reactivated recovery of these games. The host has about 12 GiB physical RAM.
- Automatic reconciliation attempted recovery concurrently; one-second scheduler invocations accumulated error handlers while replay was pending.
- A request timeout rejected the caller but did not terminate the worker. The game stopped scheduling turns while the worker could continue consuming resources.

## Changes

- A timed-out simulation host terminates its worker, rejects all pending requests and rejects future requests.
- Failed games refuse live-start/snapshot requests with an explicit recovery error.
- Automatic recovery is sequential and reconciliation is single-flight. Fresh game creation is not serialized by this background recovery loop.
- The seven user-authorized inactive test worlds were marked finished, preserving journals. Full SQLite backup: `.data/backups/before-retiring-stalled-tests-1788989911114.sqlite`. The unrelated scheduled lobby was not modified.

## Validation

Regression coverage includes timeout cleanup, pending-request rejection, sequential recovery, shared reconciliation, and refusal to present failed games as live. Existing shared-IP/multi-device protections are retained.

Isolated performance run: `scripts/benchmark-uhd-world.ts resources/maps/pixelearth27v1 .data/stall-isolated-27x.json 6000`. This uses 2,000 bots and the existing 5x trade/15x attack-divisor settings. It is a synthetic seed with no human inputs, not an exact replay of the failed game. No combat, economy, AI, map or tick-rate rules were changed in this pass.

Concurrent recovery and abandoned workers are confirmed lifecycle problems. They do not establish the exact hot function responsible for the original timed-out turn; consult the isolated CPU profile before making simulation algorithm changes.

The isolated 6,000-tick run completed: mean 87.27 ms, p95 119.61 ms, maximum 1665.57 ms, peak RSS 2335 MiB. Snapshot encoding took 1097 ms for 8.82 MB. There were no trade ships/trains and only four transports at the end: this is NOT a mature-fleet stress test. The initial CPU capture profiled the tsx launcher rather than its child and is unsuitable for hotspot attribution. A second run uses `node --cpu-prof --import tsx` directly.

Direct 1,200-tick CPU capture: `.data/CPU.20260909.174158.6244.0.001.cpuprofile`. Leading self-sample counts: AttackExecution.addNeighbors 2292, AttackExecution.tick 2179, BFS.Grid.search 1909, TileSet.add 1646, PagedGameMap.isLand 1612, TileTraversalScratch.has 1352. Border work and name placement also appear. This points the next rule-preserving optimization toward frontier traversal, set access, and map lookup locality—not trade traffic or rendering in this early-game workload. It is not a profile of the exact failed turn.
