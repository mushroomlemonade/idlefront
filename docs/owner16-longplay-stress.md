# 16-bit longplay stress preview

Updated 2026-09-27. Preview only; not a production release or a 10-TPS sign-off.

## Scope and compatibility

- New longplay worlds use 16,000 small bots only when the backend environment
  `IDLE_LONGPLAY_STRESS_BOTS=16000` is explicitly enabled. The Windows development
  supervisor reads the local runtime configuration field `LongplayStressBots: 16000`.
- Quickplay, idlefront, and previously persisted runtime configurations retain
  their existing bot counts. The stored capability is `longplayStressTest: owner16-v1`.
- Tile owner IDs support 0..65535. Low owner bits and existing chart/fallout/defense/
  visibility flags retain their old positions. Four extra owner bits live in state
  bits 16..19 and wire bits 24..27. Terrain stays in wire bits 16..23.
- Legacy state arrays remain Uint16; opted-in state uses Uint32. Legacy map writers
  reject an unsupported extended owner instead of truncating it into another owner.
- Planning-worker shared state, live deltas, reconnect runs, terrain mutations,
  fog projection and sparse trails preserve the extension.
- The wide client requires a paged map (the longplay preset is Earth 9x). Palette,
  effect, and name textures are folded into rows within a 4096-pixel texture edge.
  Wide diplomacy uses a 65,536-byte local-player row, not a square matrix.

## Verification

- 148 focused tests in 15 files passed: codec/maps, client snapshots/views,
  reconnect/compaction, runtime configuration and related coverage.
- 92 tests in eight additional files passed: warships, spatial queries, mobile
  input, water repair, catch-up/performance reporting.
- TypeScript, focused ESLint, and production Vite build passed. Build retains
  existing unresolved stone-asset warnings and large-bundle warnings.
- `scripts/owner16-gpu-check.html`, served using
  `node node_modules/vite/bin/vite.js --config scripts/owner16-vite.config.ts`,
  linked real map/trail/rail/name shaders and allocated legacy/wide textures.
- The available server browser uses software WebGL. The actual game correctly
  refuses it; no hardware gate was disabled. Full iPhone/Expo rendering remains
  a device playtest requirement, not something proven by the shader harness.

## Profiling evidence

Recent user longplay `Ssx4CmSY`: 1,531 log samples spanning 5.13 hours, minimum
rolling TPS 4.80, maximum rolling p95 443 ms, clock debt increase 3,184 seconds.
This is a log-based baseline, not a new CPU capture, and is shorter than the
eight-hour reliability gate.

Validation-only 16,000-bot game `JAqEY5sL` used the real 12324x5844 map, strategic
nations v2, normal longplay pacing and the persisted owner16 capability.
It was stopped after validation; journals and logs were retained.

| sample | rolling TPS | current tick | clock debt | update frame |
| --- | ---: | ---: | ---: | ---: |
| tick 300, opening | 10.00 | 22 ms | 23 ms | 7 KB |
| tick 400, expanding | 6.58 | 271 ms | 20.7 s | 4.29 MB |
| tick 600, expanding | 4.51 | 420 ms | 72.8 s | 4.72 MB |

The opening included a 23-second first-tick spike that later caught up before
expansion. Tick-600 shared process RSS was approximately 2.41 GB. No viewers were
receiving frames during these samples, so they do not establish phone/network
capacity. Rolling windows include the opening and must not be called steady-state TPS.

Ten-second V8 capture: `.dev-logs/profiles/JAqEY5sL-1790483479052.cpuprofile`.
Inclusive samples: PlayerExecution 36.8%, territory-cluster cleanup 25.2%, attacks
20.2%, player-update generation 10.2%, encoding 7.9%. These are nested percentages
and must not be added. No warships existed yet. Next profiling-led opportunities
are dirty/staggered territory analysis and less redundant player update/encoding
work, with deterministic tests before changing simulation cadence.

## Playtest and recovery

Update September 27: the 16,000-bot stress test exceeded the tick budget. New
preview longplays now target 3,000 bots; see `longplay-payload-3000.md`. The
prepared lobby below belonged to a different host identity, so it was not
visible on the user's iPhone. Create a normal new longplay instead. The
historical instructions below describe the original stress-test setup.

- A fresh private host-start lobby, `16,000 bots - longplay stress`, is prepared
  for the existing recent-playtest host. It has not started: the user keeps the
  entire spawn window. Open it under **your matches**, then **start game**.
- All newly created longplays on this preview currently opt into the stress count.
  Set `LongplayStressBots` to 0 and restart the preview backend to restore the
  usual count for future worlds. Existing stress journals keep their capability;
  do not remove wide-owner support while recovering them.
- Database backup: preview `.data/backups/before-owner16-20260927.sqlite`.
  Replaced source files were copied to `.data/backups/owner16-source-20260927/`.
  Old active preview records were marked finished, not deleted.
- Test territory/flags for IDs above 4095, labels and targeting, capture, bombs,
  disconnect/rejoin, and phone memory. Expect slowdown: this is intentionally
  beyond the measured 10-TPS capacity, not a stable longplay configuration.
