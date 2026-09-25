# Ordered roster follow-up: p99 target remains 100 ms

## Evidence and change

The preceding rail pass's aligned tick 15048 took 213.142 ms. Unit deletion
accounted for 55.32% of its sampled time. Every arriving/destroyed ship or train
filtered both the owner's full array and its type array: k removals from n units
could perform O(k*n) work and allocate k replacement rosters.

`OrderedRoster` uses insertion-ordered unique membership, with a lazy array view.
Removal is amortized constant-time; a subsequent query materializes survivors
once. A batch with one following read is O(k+n), not O(k*n). Type buckets are
ordered sets, so single-type queries retain their order and return fresh arrays.
This does not change traffic rates, arrival ticks, capture, economy or targeting.

An existing array iterator still visits units removed during that iteration.
Additions extend the current array until removal invalidates it; old arrays are
not extended by later additions. This is the original push/filter behavior,
not live Set-iterator behavior. Core/server no-argument roster callers were
audited: they iterate, filter, map, find or inspect; none mutate the returned
array. Typed query consumers may sort/reverse their independent result arrays.

## Validation status

- 18 tests passed initially, including 10,000 push/filter comparison mutations,
  retained snapshots, forEach length capture, delete/re-add order, actual
  capture/deletion during iteration and the existing randomized type/count tests.
- Full 15,647-turn recorded replay completed in
  `.dev-logs/profiles/fast-fame-ordered-roster.json`. Same input, all 156 rolling
  checkpoints and final gameplay hash match `fast-fame-rail-indexed.json`:
  `9ec3d88f88b4fc87f6bc9c22652d40a8d6f653378c61ca8b423f43ced2e28252`.
- 122 targeted tests passed across 14 files (ownership, deletion, combat,
  trains, trade, replay/rejoin and view delivery). Typecheck still reports only
  the two known missing declarations for idle-dev-supervisor / idle-expo-proxy.
- Large-world compute and paced-delivery gates remain outstanding; the
  27x compressed two-client repeat was started after the full replay and tests
  finished, with no other benchmark competing for CPU.

| Last 1000 turns | Before roster pass | After |
| --- | ---: | ---: |
| Mean | 47.321 ms | 46.266 ms |
| p99 | 93.708 ms | 87.529 ms |
| Maximum | 213.142 ms | 169.993 ms |
| Over 100 ms | 9 | 8 |

The targeted tick 15048 fell from 213.142 to 59.830 ms. Other hotspots remain:
rail-heavy tick 14642 is 376.170 ms; AI-heavy 14702 is 163.374 ms; the full-run
maximum remains startup tick 2 at 1009.810 ms. This is not a zero-spike claim.
Peak sampled RSS was 959 MiB. CPU profiling began at 12500 in both runs.

`benchmark-ordered-roster.ts` measures removals plus one final array read,
excluding identical setup; median of seven alternating-order trials:

| Roster / removals | Array filters | Ordered index |
| --- | ---: | ---: |
| 1000 / 200 | 1.892 ms | 0.0079 ms |
| 5000 / 1000 | 44.032 ms | 0.0313 ms |
| 20000 / 4000 | 461.358 ms | 0.1408 ms |

These are isolated data-structure timings, not whole-game speedup factors.

The paced two-consumer harness now also records dispatch, completion and enqueue
clocks against fixed 100-ms deadlines, plus scheduled-to-receipt and
enqueue-to-receipt latency. It does not move deadlines after overruns. Raw
inter-update intervals remain reported, including timer/network jitter.

## Next identified hotspot, not changed in this pass

`closestTwoTiles` sorts both input lists by x for every call. Many structure
queries pass a singleton second list. In that case a linear minimum scan can
preserve exact behavior by breaking Manhattan-distance ties on smaller x and
then original iteration order. Do not replace the general two-list heuristic
with a true global nearest pair: that would change outcomes. Measure and test
the singleton specialization separately after the roster replay.

## 27x compressed paced repeat: gate FAILS

`.dev-logs/profiles/27x-paced-roster-rail-two-clients.json` restored the same
frozen 27x world through 1200 and delivered all 1000 turns (1201–2200) in order
to both clients. No active user world interrupted the guard. No competing
benchmark/test was running. The worker and its route pool closed on completion.

- Mean authoritative work 95.937 ms; p99 **155.069 ms**, max 277.853 ms.
- Core simulation p99 **148.948 ms**; encoding p99 **0.632 ms**;
  navigation preparation p99 0.013 ms, zero worker route jobs in this window.
- Client update intervals p99 **158.312 / 158.453 ms**, max ~281 ms.
- Both clients average ~10.006 TPS, but that hides temporary clock debt:
  completion lateness p99 **1595.296 ms**, max **1613.092 ms**. Scheduled-start
  to receipt p99 ~1707 / 1708 ms; receipt deadline lateness ~1607 / 1608 ms.
- Enqueue-to-receipt p99 ~20.9 / 20.8 ms on loopback. Wire traffic remains
  ~196.9 MB per consumer over ~100 seconds. No mobile/internet claim.

This is worse tail timing than the older ~121 ms compute / ~131 ms interval
report, not an improvement. Do not infer the cause from a single run or from
the Great Lakes fleet result: the next required evidence is a clock-aligned
27x expansion CPU profile and same-input control/repeat. Core work dominates;
do not try to hide overruns by moving deadlines or slowing game rules. The
new explicit deadlines reveal backlog that the previous harness did not report.

No production push, backend restart, or user-game deletion in this pass.
The overall steady-10-TPS/p99 objective remains active and unachieved.
