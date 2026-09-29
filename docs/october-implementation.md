# October features

Do not restart the live preview backend without permission. No live-match
benchmarks or changes to its persisted simulation configuration.

1. Frontend: compact standings (land, gold, GDP), expandable full standings,
   linked bounded history charts, observed nuclear/capture annotations.
2. Longplay/idlefront only: versioned trade corridors, configurable traffic,
   bounded route reuse and expiry with terrain invalidation and native fallback.
3. Traffic-driven visual rail/sea corridors; cosmetic ship variation must not
   affect authoritative position, collisions, income, or combat.
4. Focused tests, types/lint/build, then frontend-only preview delivery. Backend
   changes remain pending permission and apply to new worlds only.

GDP means standardized completed asset replacement value, not economic output
or historical spending. History begins when this client observes the match;
do not fabricate pre-join history. Fog-filtered data stays fog-filtered.

Bound history and routing memory. Retain native fallback and all rail links
needed for connectivity. Never claim a pathfinding speedup without measurement.

## Implemented and verified, September 27

- Compact player standings explicitly use land, gold and GDP. Fullscreen reuses
  the existing virtualized table, with every player column and native scrolling.
- Desktop uses two columns; mobile uses two rows. Sorting either pane updates
  the other. The close control stays outside scrolling content.
- Charts sample every 10 simulation ticks in quickplay and 50 in slow-paced
  games, with a 10-tick response after observed nuclear/capture events. They
  retain at most 64 series, 384 samples per series and 128 event annotations.
  A visible former leader can remain on the graph after losing assets.
- History is device-local observed data, not restored pre-join match history. Missing
  players do not generate invented zero values. Fog-hidden players are excluded.
  GDP uses known, completed assets and fixed first-unit prices, not purchase
  history, inflation, income, or money in the treasury.
- Sparse observed trade corridors are capped at 12,000 edges. Actual movement
  heats them; unused edges fade/expire. Fog visibility is checked before upload.
  Shipping lane offsets are cosmetic only. Existing slow-paced worlds can use
  these visuals without changing their simulation; quickplay is unchanged.
- New-world `tradeCorridors: v1` is persisted for longplay/idlefront only. It
  ramps traffic from 25% to normal over 1h/6h respectively, atop existing rate
  controls. Existing runtime configs are not retroactively changed.
- Water routing has bounded exact-route caching and hot-corridor attachment via
  native connector searches, terrain revision invalidation and native fallback.
  Rail routing prefers short, busy connections in the existing station graph;
  cache expiry never removes a physical connection. Severed rail connections are
  checked before a train continues onto them.

### Verification

- 129 focused tests across 15 suites passed: new history/GDP/corridors, persisted
  presets, existing table modes/virtualization, rail and train behaviour, trade
  ships, rendering, snapshots and view updates.
- TypeScript, changed-file ESLint, whitespace checks and frontend production
  build passed. Build retains existing asset/chunk-size warnings.
- Isolated browser fixture: 393×852 and 1280×720; native final-row scrolling,
  linked sorting, rightmost column access, Escape dismissal, split layout and
  WebGL corridor shader compilation/draw verified. This is not physical iPhone
  or Expo device validation.

### Release boundary and remaining work

Frontend-only preview delivery completed September 27 at approximately 16:04 UTC:
19 source files, with existing files backed up under preview
`.data/backups/october-frontend-20260927-1205`. Updated UI modules returned HTTP
200; active match `TtLFpxbW` advanced from tick 24700 to 26700 during final
verification. Backend process IDs/start times were unchanged. Only the isolated
UI fixture server on port 9001 was stopped after testing.

The backend is NOT
restarted, its persisted configuration is NOT edited, and no match is terminated.
Activation of the staged simulation changes requires permission for a backend
restart and a new longplay/idlefront world.

This is a bounded first corridor implementation, not a completed routing-engine
replacement. It does not build new long-distance rail junctions into arbitrary
hot segments, delete physical low-traffic rails, or implement contraction
hierarchies. It reuses the native station graph and native water pathfinder.
The extra connector searches need a controlled mature-world benchmark before
claiming any net TPS improvement. Corridor caches and visual heat rebuild after
reconnect/recovery; they are not additional persisted world-sized heatmaps.

Playtest: open standings → fullscreen & charts; sort cities/GDP; scroll both
directions; observe a nuclear impact and its asset drop; inspect busy sea routes
and thin quiet roads. Device checks and a separate routing benchmark remain.

## September 27 follow-up: mobile fixes and authorized preview restart

The user authorized a preview backend restart in this follow-up. The historical
frontend-only release boundary above no longer describes the current preview.

- Fixed the actual mobile HUD ancestor rule that hid the fullscreen standings
  pane: it no longer shares the navbar flyout's layout class. Mobile up to 1023px
  uses equal top/bottom panes; desktop uses left/right. Shared recessed styling
  is retained without inheriting navbar hiding and size rules.
- A shared metric and direction control sorts both rankings and charts. Table
  headers update the shared selection too. The time range offers 1m, 5m, 15m,
  1h, 6h, 24h and all recorded; vertical scale offers fitted changes or zero.
- Structure/asset histories use step plots; single samples are visible dots.
  No artificial variation is invented for genuinely unchanged values.
- Timeline icons are 24px in 44px tappable groups; table header icons are 24px.
  Close control is 44px and isolated from the navbar's smaller-button rules.
- Observed history now survives rejoins using asynchronous IndexedDB storage,
  scoped to game/player/fog context and capped at two contexts. Series/sample/
  event caps remain. Older sample compaction favors meaningful changes.
- Railway splitting preserves in-flight journeys and inherited traffic counts;
  destroying replacement track invalidates the old journey. Traversal checks
  are bounded and only enabled for corridor worlds.
- Focused coverage totals 133 passing tests across 17 suites (131-test combined
  run plus the dashboard interaction and rail-splitting regressions). TypeScript,
  changed-file lint and frontend build passed; existing build warnings remain.
- Responsive browser checks used the actual HUD/navbar ancestor structure at
  393×852 and 1280×720. Split pane dimensions and time-range/metric changes were
  checked. Sort-direction interactions also have a DOM regression test. Physical
  iPhone/Expo touch verification is still a playtest item.
- 34 files deployed to preview with hash verification. Backup:
  `.data/backups/october-update-20260927-1330`. Preview backend restarted at
  17:28 UTC; both workers reported ready. Expo, gateway and Vite processes were
  left running. Existing local cosmetics-service warnings remain unrelated.
- Start a NEW longplay/idlefront world to receive persisted `tradeCorridors: v1`;
  existing saved-world configurations were not edited. Quickplay stays native.

### October request audit: not all routing ambitions are complete

The leaderboard/UI requests are implemented, subject to physical-device testing.
The initial trade corridor implementation is available for testing, but it is
not the entire proposed highway-routing architecture. Remaining work:

1. Short new rail connectors/junctions into busy segments, rather than only
   preferring existing station graph connections.
2. Per-new-route traffic maturation: the current configurable ramp uses world
   age, not each newly built port/station's age.
3. Controlled mature-world measurements of route reuse, connector cost, memory
   and TPS. No net performance improvement has been demonstrated yet.

Unused cached route candidates expire; physical rail connectivity is preserved.
Visual heat is client-observed and rebuilds on rejoin, unlike the saved chart
history. No unobserved history or world-sized persistent traffic map is added.
