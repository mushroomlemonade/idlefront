# Pixel Earth 27× v1 — terrain and rendering pass

## Status (2026-09-08)

New versioned asset `PixelEarth27v1`: 21,344 × 10,124; installed at `resources/maps/pixelearth27v1`, generator input at `map-generator/assets/maps/pixelearth27v1`. Validated candidate is `.data/pixel-earth27-vector-v8`; earlier numbered candidates are failed experiments, not release assets.

**Activated after explicit user authorization to kill the backend at will.** The backend was restarted (PID 12856), and `pixel-earth-27x` is included in the public custom-game presets. Two active worlds were present (`Playtest with Simon`, `Mega map`); their persisted records and original map identifiers were not deleted or replaced. No production push.

## New terrain, not a stretched old map

Land is rasterized anew from version-pinned Natural Earth land polygons, including holes and Pacific wrapping. Existing source terrain magnitudes are sampled with nearest-neighbour filtering, avoiding interpolation of water colour into coastal terrain classes. Lakes/river geometry is composed onto that land raster. Ontario river features from the Natural Earth North America supplement are included; this still does not supply a complete Trent–Severn canal network.

The St Lawrence geographic coast receives bounded 32× supersampling before reduction. Any covered geographic water preserves a water tile. After all river/lake composition, diagonal-only water contacts are converted to cardinal contacts by adjusting a bank tile, protecting enclosed land islands. This is an explicit minimum navigable-width concession, not metre-accurate channel widths. Broad closing/perimeter-widening experiments were removed from the final implementation.

Root cause: river/lake composition introduced a final diagonal contact near −75.99243, 44.38562. Earlier cleanup ran before composition and could not repair it. The half-grid falsely appeared connected; full-resolution validation correctly rejected it. Final St Lawrence path has 471 points / Manhattan length 470, zero dry cells and no dry-corner cuts.

Geographic sources: https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-rivers-lake-centerlines/ and version-pinned `nvkelso/natural-earth-vector` v5.1.2 GeoJSON (URLs/hashes in manifest). Natural Earth is public domain; OpenFront-derived terrain/nation attribution and CC BY-SA asset notices remain. External OpenStreetMap queries failed; **no OSM data was incorporated**. Original height classes are not a newly surveyed elevation DEM.

## Renderer

`OverviewMapPass` now uses integer power-of-two, globally aligned sampling rather than a noninteger overview grid. Intermediate camera-local levels fit the existing fixed atlas budget. A viewport uses one detail level; distant views explicitly disable stale resident detail pages. Visible resident pages are touched before eviction to prevent deleting a page needed in the same frame. Ownership/terrain updates map onto the same representative texels. Native resolution still uses nearest-neighbour integer texture fetches.

Restored the canonical OpenFront terrain colour/magnitude and shore-water/shore-land shading instead of three generic green tones. No HDR or terrain-bit-depth change was introduced: existing magnitude thresholds, impassable value and terrain attack multipliers remain unchanged. Discrete pixel LOD changes remain discrete; this is not blurry crossfading or a promise of zero temporal aliasing at every zoom.

## Validation

- TypeScript `--noEmit` passed.
- 37 focused renderer, custom-game and boat tests passed; activation UI tests rerun separately.
- 20 geographic connectivity checks: ten routes × full/half resolution, including St Lawrence, Panama, Suez, Gibraltar, Bosphorus, Dover, Mississippi, Rhine, Amazon, Dardanelles.
- Eight production boat paths pass endpoint, adjacency, dry-terrain, corner and detour checks. Release report resets to false before each run, avoiding stale passing reports after failure.
- **Trent–Severn still fails** its bounded full-resolution test; do not claim it is navigable.
- Real paged GLSL compiled/rendered in isolated headless Chrome at zoom 0.1, 0.4 and 2 with no GL errors. Screenshots at `.data/pixel-earth27-vector-v8/gl-zoom-*.png`; intermediate and close-up screenshots inspected. This geographic fixture loads only Ontario/Quebec pages, not a full game or performance benchmark.
- Mature-world throughput and physical iPhone visual/performance testing are not certified by this pass.

## Reproduction / remaining work

Run `scripts/generate-hd-earth.py --area27 --pixel-terrain --output-root=FRESH_DIRECTORY`, then both `verify-hd-earth.py` and `verify-hd-earth-engine.ts`. `check-trent-severn.py` reports the known separate limitation. `diagnose-st-lawrence.py` is read-only: it locates minimal dry barriers and never carves an invented route.

Renderer QA: start Vite with `scripts/pixel-preview.vite.config.mjs`, visit `/scripts/pixel-map-preview.html?zoom=0.4` on localhost:9002. It intentionally does not run game simulation. Both QA and main Vite file watchers now exclude `.data` and `.dev-logs`: the headless browser profile caused an EBUSY watcher crash in the main preview. The main preview was restored on port 9000 (PID 3568); the game backend itself had remained alive until the authorized restart. QA server PID: 6528.
