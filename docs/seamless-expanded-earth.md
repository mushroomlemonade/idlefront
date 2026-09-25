# Seamless Expanded Earth implementation

## Purpose and non-negotiable boundaries

This branch proves that one ordinary OpenFront match can use a board that is
twice the Giant World Map's width and twice its height. Expanded Earth is
8,216 × 3,896 tiles: exactly four times the original tile area. It remains one
continuous topology, one simulation, and one game. Terrain pages are storage
and traversal units only; they are not gameplay sectors, independent matches,
or atlas screens.

The current OpenFront ruleset remains the game's laws of physics. This work
does not alter structures, combat, economy, diplomacy, AI behavior, camera
semantics, or player input. Persistent-world configuration selects the new
board, 2,000 bots, all default nations, and OpenFront's existing Medium AI.

## Architecture

`GameMap` now exposes page metadata through `tilePages()` while retaining one
canonical global row-major `TileRef` address space. `PagedGameMap` maps those
global references to bounded page-local arrays. Its lookup, mutation,
neighbor, coordinate, and distance behavior is indistinguishable from one
contiguous rectangular map, including across page seams.

The implementation supports arbitrary rectangular page grids and clipped
edge pages. The current 1,024-tile page size and 9 × 4 Expanded Earth layout
are asset-generation choices, not engine limits. Tests construct a 16 × 16
page map and verify global addressing and cross-page behavior, so future maps
are not structurally limited to a 2 × 2 arrangement or to this demo's scale.

Paged terrain uses a versioned `paged-v1` manifest. Each page records its
grid position, actual dimensions, byte length, relative path, and SHA-256
digest. Browser, binary, and Node loaders all consume the same manifest.
Traversal scratch buffers, connected-component analysis, and water
pathfinding allocate and read page-local state rather than requiring a second
full contiguous terrain array.

Expanded Earth is reproducibly generated from the checked-in Giant World Map
source assets. The generator scales terrain, thumbnails, nation coordinates,
and spawn metadata together, then writes the manifest and 36 binary pages.
The normal repository generation and consistency checks recognize the paged
format. See `scripts/generate-expanded-earth.mjs` and
`resources/maps/expandedgiantworld/NOTICE.md`.

## Current renderer bridge

The authoritative simulation map is paged. For the first playtest, the
unchanged OpenFront GPU renderer receives a compatibility mirror in its
existing contiguous texture layout. This keeps map appearance, sampling,
camera behavior, and gameplay interaction identical to current OpenFront and
avoids inventing a replacement renderer before the demo is validated.

That bridge is deliberately not presented as the final renderer for much
larger worlds. It requires a GPU whose maximum texture dimension can contain
the 8,216-tile map width and it retains full-map client buffers. Supporting
maps substantially larger than Expanded Earth will require page-resident GPU
textures or texture arrays, viewport-aware uploads, and bounded render-state
residency. The core topology, storage, loader, generator, and traversal work
already provide the page boundary that renderer can consume later.

Owner IDs were audited separately. The client now supports the full 4,096-ID
range in map state, diplomacy relation matrices, and border-relation textures,
including IDs used by the 2,000-bot configuration.

## Evidence

- Expanded Earth manifest: 8,216 × 3,896, 9,341,612 land tiles, 36 pages,
  32,009,536 terrain bytes, and 107 scaled nation coordinates.
- Full client/core suite: 290 test files and 3,163 tests passed.
- Server suite: 48 test files and 393 tests passed.
- TypeScript checks passed for both web/server and the Expo mobile shell.
- The development Vite bundle completed and copied the manifest and all edge
  pages into the output.
- A real 2,107-player simulation (2,000 bots plus 107 nations) completed spawn
  in 302 turns. Over the following 100 ticks it measured 53.4 ms mean,
  58.5 ms p50, 76.6 ms p95, and 162 ms p99/maximum, with two ticks over
  100 ms and approximately 90 MB peak JavaScript heap.
- A local persistent lobby reached the live game route and loaded Expanded
  Earth's session/map data.

Automated visual certification is still blocked: both controllable browsers
on this Windows host report a software SwiftShader renderer, and OpenFront
correctly refuses to start gameplay without hardware acceleration. The first
real rendering, touch, memory-pressure, and frame-time gate therefore must be
run on the target iPhone through Expo Go (and then a hardware-accelerated
desktop browser). This is a stated validation gate, not a passed one.

## Commit chain

1. `858f01c5` — scalable paged game-map foundation
2. `ff851436` — arbitrary paged map manifests and loaders
3. `e35f3183` — reproducible Expanded Earth assets and world configuration
4. `5f11104a` — page-safe traversal and water paths
5. `88a9e2a0` — compatibility bridge into the current client renderer
6. `f4c29fce` — diplomacy across the full owner-ID range
7. `f94f8959` — reproducible generation and asset licensing notice
8. `5810d7ef` — repository generation and consistency integration

## Next gate

Do not change pacing or core OpenFront mechanics yet. First run the exact demo
on real mobile hardware, confirm that the full board renders, enter as one
human among the bot and nation population, pan and zoom across page seams, and
record memory and frame behavior. Any failure should be fixed at the paging or
renderer boundary without reducing the board to multiple matches.
