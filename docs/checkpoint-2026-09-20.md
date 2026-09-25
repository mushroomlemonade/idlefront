# Idlefront — pacing and mobile HUD checkpoint

Approved for main/production by the owner on September 20, 2026.

Includes continuous population pressure, civilian/military mobilisation, shared
manual/AFK pacing, grace periods, alliance protection, scheduled/custom mode
scaffolding, and the accumulated mobile HUD and menu refinement.

UI includes compact troop/attack sliders, status tickers and flyouts, live rank,
safe-area-aware navigation, wizard docking, and native ghost-preview drag wiring.

## Verification and follow-up

- 109 focused population, pressure, world-service, and UI tests passed before packaging.
- Staged lint/format checks and the production bundle/typecheck were verified.
- Mobile drag placement remains experimental: the user reported unsuccessful
  construction; automated gesture tests are not end-to-end device verification.
- Mobile nuclear interaction needs a dedicated UX pass; do not claim it complete.
- Older wizard/radial tests contain outdated presets or incomplete mocks and need
  updating; a full-suite pass is not claimed.
- Large-world steady TPS, reconnect behaviour, and device layout need further
  prolonged playtesting. This is a development checkpoint, not a final release.
- Production uses the existing main pull/build deployment cycle. Pushing does
  not itself verify that the public endpoint has deployed this revision.

Temporary icon profiles, generated scratch images and Python caches are excluded.
