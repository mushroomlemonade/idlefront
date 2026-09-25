# Pixel Earth 27x v1

This version rasterizes Natural Earth v5.1.2 land polygons afresh, including polygon holes and Pacific wrapping. Terrain classes are nearest-sampled from the attributed OpenFront source master. The St Lawrence region uses bounded supersampling and island-preserving cardinalization of composed river/lake contacts. Sub-tile channel widths are deliberately exaggerated for navigability. No new elevation survey or HDR terrain range is claimed. See docs/pixel-earth27-v1.md for validation and known limitations.

Adapted from the high-resolution terrain master linked by OpenFront map-generator/README.md, and OpenFront nation metadata. OpenFront and its contributors retain attribution. Distributed under the repository LICENSE-ASSETS (CC BY-SA 4.0).

River/lake geometry: Made with Natural Earth, version-pinned v5.1.2 repository data, public domain. https://www.naturalearthdata.com/about/terms-of-use/

Changes: downsampled high-resolution master; registered crop; rasterized major rivers and lakes; recomputed shore/ocean/depth; adjusted water-bound nation spawns; paged output. Source URLs and SHA-256 fingerprints are in manifest.source. Rebuild with scripts/generate-hd-earth.py and scripts/generate-expanded-earth.mjs.
