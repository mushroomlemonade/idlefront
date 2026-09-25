# HD Earth candidates — 9x and 16x area

Prepared locally in `.data/earth-hd-v1-final/`. The 9x candidate is now
installed under its own map ID and available through the experimental
**9× HD Earth** quick-start button. Existing map assets were not overwritten;
never substitute this terrain into an existing world's replay. The 16x
candidate remains offline. With user approval, the three previous active
test worlds were cancelled (history retained) and the backend restarted.
Quick start retains 5x trade ships, 5x trains and 15x slower attacks.
Boat path refinement can still clip riverbanks; this is an experimental test.

| Candidate | Dimensions | Terrain pages |
| --- | --- | --- |
| `expandedgiantworldlargehdv1` | 12,324 × 5,844 | 78 |
| `expandedgiantworldultrahdv1` | 16,432 × 7,792 | 136 |

The 9x/16x names refer to tile **area** relative to the original Giant World
Map, not a nine-/sixteenfold increase in each dimension. Candidate directories
are under `.data/earth-hd-v1-final/maps/` and contain paged-v1 manifests,
checksummed terrain pages, half/quarter-linear LODs, thumbnails and notices.

## Source and approach

The existing XL generator repeats a 4,108 × 1,948 raster. Ultra interpolates
that same source. These candidates instead downsample the 21,600 × 10,800
`large_world_map_recolor.tif` linked in `map-generator/README.md`:
https://drive.google.com/file/d/1W2oMPj1L5zWRyPhh8LfmnY3_kve-FBR2/view

Master SHA-256:
`c906d1cd7facd507c0751c73408bcd4d3eba83bf08ffef7feaf3a11f9ee667ca`.

Source-image feature matching found 450 affine inliers out of 538 matches;
the fitted crop was approximated by the geographic 11-degree Pacific shift
and 85N..80S latitude crop. Registration is approximate, not survey-grade.
Nation locations retain their previous vicinity and are snapped to nearby
land where improved coasts move their original point into water.

Natural Earth v5.1.2 repository GeoJSON provides lakes and rivers of scale
rank 6 or better. It is public domain:
https://www.naturalearthdata.com/about/terms-of-use/

Generalized, manually positioned sea approaches and narrow-passage
centerlines are explicitly recorded in `scripts/earth-navigation-passages.json`.
They are **not surveyed banks**. Canal interiors use Natural Earth geometry.
Rivers and sub-tile straits receive a small raster width to preserve gameplay
connectivity. Limited single-cell gap repair is restricted to mapped waterway
corridors; there is no global coast erosion. Canal locks are not simulated.

Terrain encoding follows `map-generator/map_generator.go`: land/shore/ocean
bits and blue-channel-derived magnitude. This is more detailed source terrain,
not a new DEM or a physical-elevation model. Generation uses packed arrays and
single-threaded processing, then calls the existing JS paged exporter rather
than allocating the Go generator's large per-tile struct grid.

The candidate notices retain OpenFront attribution/CC BY-SA asset terms and
identify the external sources. Before public distribution, confirm the linked
master's original attribution/license chain; the external TIFF itself does
not contain a license tag. No public distribution was performed here.

## Validation and remaining blocker

- Every terrain page's length and SHA-256, total land count and all nation
  land placements were checked.
- **36/36** bounded-region, four-neighbor connectivity checks pass: nine
  routes, two map sizes, full and half-linear resolution. Panama and Suez
  cannot pass these checks by taking an ocean detour around a continent.
- Routes: Panama, Suez, Gibraltar, Bosphorus, Dover, Dardanelles, lower
  Mississippi, lower Rhine, lower Amazon.
- All 14 production pathfinder queries find short routes, **but the dry-tile
  check fails**: `MiniMapTransformer.upscalePath` expands coarse points by
  multiplication/interpolation without checking full-resolution water. For
  example, the 9x Panama route includes two bank tiles. The reports explicitly
  set `releaseReady: false`; the engine verifier exits 2 for this condition.
- This existing route-refinement issue should be fixed before deployment.
  Do not hide it by converting every coast into coarse 2x2 water blocks.
  A full-resolution constrained refinement/fallback must preserve valid
  water paths and be performance-tested separately.
- Existing map/paged-map tests: 10 passed. TypeScript check passed.

These checks do not certify all real-world waterways or ship draft limits.
New geographic detail does not by itself guarantee navigation along every
river. No giant-map simulation performance claim is made by this asset pass.

Reports: `waterway-validation.json`, `engine-waterway-validation.json`.
Visuals: `comparison-{9,16}x-{britain,great-lakes,greece}.png`, comparing actual
shipped terrain and candidates at native tile scale using the same palette.

## Reproduction

Dependencies: Python with numpy/Pillow, opencv-python-headless 5.0.0.93;
the local isolated installation lives under `.data/map-tools`. Node uses the
repo's existing tsx dependency. Download the three URLs recorded in
`scripts/generate-hd-earth.py` to `.data/map-sources/` under their recorded
filenames. The generator records all input hashes in each manifest.

```
python scripts/generate-hd-earth.py --output-root=.data/earth-hd-new-build
python scripts/verify-hd-earth.py .data/earth-hd-new-build
node node_modules/tsx/dist/cli.mjs scripts/verify-hd-earth-engine.ts .data/earth-hd-new-build
```

Use a fresh output directory; the tools reject overwriting prior candidates.
Generated assets are intentionally in gitignored `.data`. Deployment requires
versioned map registration and an explicit new-world selection, not replacing
the old map IDs. Keep old assets for saved-game compatibility.
