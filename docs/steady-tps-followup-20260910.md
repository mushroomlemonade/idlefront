# Steady-TPS follow-up — September 10, 2026

Goal remains steady delivered 10 TPS, not simply an average benchmark above 10.
The preceding turn made progress (deployed four-stage optimizations with 175
passing tests and deterministic replay evidence) but did not meet that goal.
No active persistent matches were present at the start of this continuation.

## New evidence

Current 27x profile, recorded turns 1000–1599 (85 seconds sampled):
`.dev-logs/profiles/27x-current-profile.json.cpuprofile`.
Attack execution 67.69% inclusive; conquest 32.97%; border maintenance 14.77%;
frontier candidate insertion 16.45% in its dominant call tree. These overlap.
Garbage collection was under 1%; graphics were not part of this headless run.
The top 25 heavy-window outliers in the previous replay fell on turns ending
at multiples of 30: the synchronized all-country label-placement refresh.

## Changes

- A host-only map preparation hook lets the Node simulation select contiguous
  row-major terrain/state arrays. This avoids repeated page-coordinate lookups
  in the innermost expansion loops. It uses the existing GameMapImpl rules,
  not a different map, terrain resolution, or client renderer.
- Auto mode caps total terrain+ownership allocation at 768 MiB, one eighth of
  host/container memory, and available memory minus a 1 GiB reserve. Larger
  worlds/low-memory hosts retain paged storage. IDLE_SIMULATION_STORAGE=paged
  disables conversion; linear explicitly opts in but keeps the 768 MiB cap.
  Conversion is only permitted for an unmodified fresh PagedGameMap.
- Label placement stays on a 30-tick per-country cadence, staggered by smallID.
  Spawn positioning/initial placements remain immediate. Live packets carry
  changed labels only; ViewSnapshot merges them for complete rejoin snapshots.
  This is an intentional change to cosmetic update phase, not game state.
- Clients update existing cached label entries in place so staggered packets
  don't cause a full label-map rebuild every tick on phones.

The layout is a locality/constant-factor improvement, NOT proof that arbitrarily
larger maps now scale or that regional simulation is unnecessary. Paging remains
available beyond the bounded allocation; that path still needs further work.

## Unpaced replay comparisons

Same frozen 27x inputs and 2,200 turns, isolated sequential processes:

| Last 1,000 ticks | Four-stage paged | Linear only | Linear + labels |
| --- | ---: | ---: | ---: |
| Mean compute | 138.04 ms | 92.12 ms | 90.84 ms |
| p99 compute | 291.21 ms | 155.45 ms | 118.44 ms |
| Maximum | 329.20 ms | 188.59 ms | 134.74 ms |
| Capacity | 7.24 TPS | 10.85 TPS | 11.01 TPS |

Reports: `27x-after-four-stage-v2.json`, `27x-linear-layout.json`,
`27x-linear-staggered-labels.json`, under `.dev-logs/profiles/`.
All final gameplay-update hashes match
`0d92157e9b86dfd5cc23c1751db5b7f84189ace42be423c5f67a5476be230d71`.
The hash covers ordered simulation updates and packed state/motion/attack data;
cosmetic label placement is not part of that hash and is tested separately.

## Paced delivery validation

`scripts/benchmark-paced-simulation.ts` restores the exact recorded world in
the actual SimulationHost worker, then drives its real turns on a 100 ms clock.
Two loopback WebSocket consumers receive through the existing ViewConnection
ACK window, decode packets, and verify no missing/duplicated/reordered ticks.
It stops its worker if a user starts an active persistent match. It does not
write to the world database. This covers authoritative worker, encoding, IPC,
WebSocket transport and ACK pacing, but NOT mobile rendering or internet RTT.

The uncompressed control completed: both consumers received exactly 1,000
consecutive updates (1201–2200) at 10.0047 TPS. Interval p99 125.9 ms, maximum
142.9 ms. Mean authoritative duration 92.31 ms, p99 118.14 ms. Report:
`.dev-logs/profiles/27x-paced-two-clients.json`.
Its 418 MB/consumer count is uncompressed application bytes, not the real
internet bandwidth; Worker.ts already negotiates permessage-deflate.

The second run matched Worker.ts compression settings:
`.dev-logs/profiles/27x-paced-compressed-two-clients.json`.
Both clients received all 1,000 ticks in order at 10.0028 / 10.0030 TPS.
Interval p99 was 131.70 / 130.34 ms; maximum 168.77 / 170.53 ms.
Mean authoritative duration 94.21 ms, p99 120.98 ms. No growing clock backlog
or missing updates occurred in this window, but residual outliers remain.
Wire bytes were 196,886,539 per client over ~100 seconds (~15.8 Mbit/s each),
versus ~418 MB of decoded data. Internet bandwidth can still be material for
an unfiltered 27x world; localhost results do not prove mobile network behavior.

Goal is NOT marked complete: this establishes a 10 TPS expansion-window result,
not stable timing throughout a mature, fleet-heavy prolonged human playtest.

## Validation / dev deployment

- 247 targeted tests passed across 30 files, including both layout variants,
  late-view snapshots, fog, label cadence, client label caching, routes and
  ordered border behavior.
- Typecheck has only the same two pre-existing missing declarations for the
  idle-dev-supervisor.mjs / idle-expo-proxy.mjs test imports; no new errors.
- Dev backend was gracefully refreshed at 20:38 EDT with no active persistent
  worlds. Master 11336; workers 12772 and 5804. Logs:
  `.dev-logs/steady-backend-20260910.out.log` and `.err.log`.
  Direct/proxied health endpoints both report `ok`; Backend supervisor resumed.
  Production untouched; no games or journals deleted.
- New world simulation workers use auto storage selection. Expo and browser
  clients retain the same paged rendering architecture and map assets.

The frozen 27x input has only one human City build. Its early window does not
exercise a mature human fleet. The frozen Fast fame input has 76 human builds,
ports beginning at turn 4063 and warships through 13873; that is the appropriate
next replay for validating route-cache/pool behavior under mature traffic.
