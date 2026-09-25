# HD Earth candidate v1

Adapted from the high-resolution terrain master linked by OpenFront map-generator/README.md, and OpenFront nation metadata. OpenFront and its contributors retain attribution. Distributed under the repository LICENSE-ASSETS (CC BY-SA 4.0).

River/lake geometry: Made with Natural Earth, version-pinned v5.1.2 repository data, public domain. https://www.naturalearthdata.com/about/terms-of-use/

Changes: downsampled high-resolution master; registered crop; rasterized major rivers and lakes; recomputed shore/ocean/depth; adjusted water-bound nation spawns; paged output. Source URLs and SHA-256 fingerprints are in manifest.source. Rebuild with scripts/generate-hd-earth.py and scripts/generate-expanded-earth.mjs.
