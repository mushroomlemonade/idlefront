# Warship corridor reuse and impossible-route proofs

## Scope

Performance-only routing pass; no UI, combat balance, targeting, fleet limits,
resources, or ownership rules changed. No preview deployment or restart during
the current longplay.

- New longplay/idlefront configurations persist
  `tradeCorridors.warshipRouting: shared-v1`. Legacy configurations and quickplay
  retain native warship routing. Do not inject the flag into an existing replay.
- Warship journeys of at least 96 Manhattan tiles share the same per-game
  corridor cache as trade ships. Short trips, pursuit/capture and retreat use
  native routing. Manual destination changes invalidate traversal as before.
- The existing overlay bounds candidate routes (8), sampled portals (~66 each),
  connector distance (32), retained routes (128) and nodes (250,000). Native
  fallback remains available. Joined routes may detour by at most 25% of the
  Manhattan distance; this is deliberately conservative, not a promise of
  optimal routing. Sampled portals can cause small local backtracking.
- Each ship owns its traversal cursor, not a duplicated shared path. No player
  target, trade ownership or fog state is shared by this geography cache.
- Terrain conversion and graph revisions invalidate route/proof caches. Active
  path refresh retains existing graph-rebuild timing; localized invalidation is
  not implemented here.

## Failed searches

Existing exact failure caches and reverse destination-component proofs were
already present. This pass extends them rather than adding a second cache:

- Exhausted single wet-source components of up to 8,192 tiles become reusable
  proofs only if every wet edge remains inside the fully explored component.
- At most eight component proofs are retained. Their dry shoreline boundaries
  remain exceptions because native routing permits dry endpoints.
- Proven disconnection is reusable in either direction and for different
  endpoints, including multi-source queries only when every source is blocked.
- Proofs are checked before coarse routing, refinement, and main-thread worker
  preparation. Worker-local refiners also reuse their own proofs.
- Search-budget exhaustion and corridor-only disconnection are never promoted
  to global proofs. Terrain revision changes clear proofs immediately.

## Evidence and limitations

`scripts/benchmark-warship-failures.ts`: five warmed alternating runs, 100
different requests from a 1,024-tile enclosed basin in a 256x128 map. Baseline
uses the previous search-local reverse check without cross-request source
proofs; those requests finish before its 4,096-expansion trigger.

- Expanded tiles: 102,400 -> 1,024; 99 proof hits after the first search.
- Median batch time: 12.313 ms -> 0.356 ms on this machine.
- Synthetic disconnected-source workload only, not total game performance.

Tests cover shared trade/warship geometry, independent cursors, reverse trips,
native pursuit/retreat, target changes, detour bounds, terrain invalidation,
saved configuration opt-in, dry boundary endpoints, multiple sources,
corridor-limited failures, budget exhaustion, and varied endpoint equivalence.
Existing warship combat tests also run with the new routing flag enabled.

Verification: 143 tests passed across eight focused suites; TypeScript,
changed-file ESLint, whitespace checks and production build passed. The build
still reports existing missing stone-texture and large-chunk warnings.

Still required: deploy at an approved restart, start a new configured world,
then measure mature-world corridor hit rate, navigation time, total tick time,
clock debt, and memory. No whole-game gain or sustained 10 TPS is claimed.
