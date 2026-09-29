# Trade corridors: performance-first implementation brief

Primary goal: measurably reduce longplay/idlefront routing CPU, allocations,
route memory and worst-tick maintenance costs at identical traffic workloads.
Visual corridors are required gameplay feedback, not the source of the claimed
optimization. Quickplay retains native routing and trade behavior.

No new UI: no panels, inspectors, buttons, labels, statistics readouts or settings
screens. Only map rendering changes. Thin secondary rail lines and stronger
primary trunks, plus faint-to-blue shipping lanes, communicate observed traffic.
Players use existing bombing and warship controls to disrupt these routes.
Busy does not imply most profitable; rendering must not invent economic data.

Inspect and extend native routing/execution, not a parallel simulation. Prefer
bounded short connectors into shared routes, compact graph searches, immutable
shared geometry with independent cursors, bounded caches, staggered maintenance,
local invalidation and safe native fallback. Preserve ownership, alliances,
trade accounting, fog, destruction and train continuity through rail splits.
Do not grant bonuses or reduce unit counts to manufacture routing improvements.

Per-route maturation must eventually replace the global-age traffic ramp, using
versioned settings compatible with saved games/replays. No silent migration.
New rail connections should reuse useful trunks without orphaning structures.
Never route through destroyed infrastructure or paint lanes across land/fog.

Measure baseline and candidate on identical deterministic workloads: route calls,
search work, allocations, retained path bytes, maintenance and damage costs.
Report fixture size/duration and distinguish microbenchmarks from whole-match TPS.
Reserve verification effort; tests/types/lint/build before preview deployment.
Backend restart is authorized for this task; production deployment/push is not.

## Acceptance checklist

- [x] Benchmark existing routing and path-copy costs in isolated fixtures.
- [x] Eliminate repeated active journey geometry copies for cached trade routes.
- [ ] Bound candidate/maintenance work and share reverse routes where legal.
- [ ] Extend rail attachment and local invalidation without unsafe shortcuts.
- [x] Version and test per-route maturation.
- [x] Render observed primary rail/sea traffic with bounded geometry and no new UI.
- [ ] Verify quickplay, fog, destruction, independent cursors and memory caps.
- [ ] Report measured gains/regressions; deploy preview only after checks.

If a stage is incomplete, identify it explicitly. Do not describe the entire
Google-Maps-style hierarchy as shipped merely because route caching improved.

## First implementation checkpoint (September 27)

Implemented optional shared path geometry, independent per-unit cursors, an
expiry sweep at most once per second (individual entry expiry remains exact),
bounded short connectors into busy existing rail geometry, and per-route traffic
maturation for new configs. New flags `routing: shared-v2` and
`maturation: route-v1` are persisted through the existing preset/config pipeline;
old configs without them retain old construction/pacing behavior. Quickplay has
no corridor config and keeps its native pathfinder and traffic behavior.

Rail connectors sample at most 32 nearby candidates, 65 points per candidate,
then at most two native connector searches. They retain the native fallback,
require live physical track and cap detours at 25% of Manhattan distance.
Connectors are limited to 24 tiles by endpoint distance and 48 travelled tiles.
The native search itself still uses its native work limit; a geographically
short connector is not proof of a cheap search on difficult terrain.
Connections remain ordinary destructible/splittable rail geometry, not virtual
cross-map links. This is trunk geometry reuse, not a new junction-graph engine.

Per-route maturation uses a bounded 4096-entry, per-game map of directed source/
destination opportunities. It begins at the first attempted departure and resets
after disuse or eviction. It is reconstructed through simulation/replay, not an
extra persistence store. It does not claim to measure completed deliveries.
Visual emphasis still uses observed movement, not this opportunity counter.

Map-only changes: busy rail paths use warmer/brighter, wider lines that remain
distinct at strategic zoom; sea lanes deepen blue. Width is screen-space bounded.
No textures, management panels, inspection readouts, input handlers or network
fields were added. Uniform locations are cached instead of queried every frame.

### Isolated measurements (same Windows server)

| Mechanism | Before | After | Workload |
|---|---:|---:|---|
| Retained active journey geometry | 65,536,000 bytes | 524,288 bytes | 4,000 journeys, 32 routes, 4,096 nodes/route |
| Acquisition total | 371.19 ms | 11.64 ms | Same repeated-route fixture |
| Native rail search expansions | 469,992 | 8,902 | 500 connections, 1024×256 land grid, 961-tile trunk |
| Rail routing total | 54.85 ms | 15.80 ms | Includes spatial lookup and connectors |
| Rail p95 / p99 | 0.172 / 0.220 ms | 0.050 / 0.175 ms | Same land-grid fixture |
| Total route length | 469,992 | 473,484 | 0.74% longer in this fixture |

The path-memory measurement counts unique retained stepper buffers, not total
process/client memory, cache overhead, motion-plan encoding or network storage.
Both path-copy variants made 32 native calls and 3968 exact cache hits. No traffic
was removed. Rail measurements use the native A* adapter, but favorable synthetic
terrain and one established trunk. These are not mature-world TPS measurements.

Reproduce: `node --import tsx scripts/benchmark-trade-corridors.ts` and
`node --import tsx scripts/benchmark-rail-trunks.ts`. The first script measures the
current implementation; baseline values above were captured before editing.

### Still required for the full architecture

- Region/junction hierarchy and shared multi-corridor journeys (beyond current
  single-trunk attachment and station-graph reuse).
- Local damage dependency tracking instead of global water-cache invalidation.
- Mature-world end-to-end tick, memory, payload and rendering measurements.
- Physical iPhone/Expo and real map visual validation. Browser fixture confirms
  shader compilation/draw and quiet/busy contrast, not a longplay field test.

Bombing and interception retain native mechanics. There is no new mechanic that
permanently destroys an isolated bare piece of rail independently of its stations.
Do not imply that every visible rail tile is a new damageable building.

Verification: 115 focused tests across 17 suites passed, plus the final expiry
regression rerun. TypeScript, changed-file ESLint, build and whitespace checks
passed. Existing material/chunk build warnings remain. Browser rendering fixture
reported WebGL error 0 and visibly differentiated quiet/busy rail and sea lines.

Preview: ten source files deployed with hash verification and backups at
`.data/backups/corridor-performance-20260927-1658`; preview backend restarted with
user authorization. No production push, new management UI, or saved-world config
rewrite. New behavior flags require a new longplay/idlefront world.
