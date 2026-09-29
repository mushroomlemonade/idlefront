# Server history and Newt follow-up — 2026-09-28

## Implemented

- The simulation records trade-ship and train journey geometry without viewers.
  Joining devices receive current corridor summaries in their snapshot; live
  replacements arrive every 300 ticks. Unrelated explosions no longer clear all
  route history. Only affected terrain/rail routes are invalidated.
- Leaderboard history is recorded every 100 ticks without viewers, returned on
  demand for the chosen sort metric, and refreshed while its dashboard is open.
  Remote worlds no longer depend on the browser's historical samples/IndexedDB.
- Both histories rebuild through the existing journal recovery pipeline. No
  database migration or second simulation/checkpoint format was introduced.
- Port candidate enumeration uses a tick-local typed roster; ownership, diplomacy,
  construction, destruction and elimination remain checked. Weighted unit-price
  counts are cached with ownership, level and construction invalidation.
- Failed water searches now cache bounded ordered multi-source requests. Route
  diagnostics distinguish synchronous search time from background preparation,
  and retain the latest 16 failed endpoint/revision fixtures for investigation.
- New longplay/idlefront configurations opt into `tradeCorridors.economy=area-v1`:
  trade density uses actual map area instead of mismatched literal map names;
  nation replenishment uses reserve-aware affordability and port coverage instead
  of the fixed 48 target. Native/reactive warship spawning remains available.
  Existing configurations retain their prior simulation decisions.
- Archive records get a deterministic archive-only UUID when a restored client
  lacks a valid persistent identity. Authentication/game identities are unchanged.

## Bounds and semantics

- Corridors: at most 256 routes / 100,000 stored tile references; prefer busy routes
  over one-off routes. Collinear simplification follows real paths, not shortcuts
  across land. Maximum replacement is 20,000 segments / 320 KB before transport
  overhead, every 30 simulation seconds, not every tick.
- Heat measures planned trade journeys, **not delivered gold or guaranteed profit**.
  Inactive routes expire after the configured idle period (default 30 simulation
  minutes); active lanes refresh while no devices are connected.
- History: at most 512 series, 256 points each, 14 doubles per point (~14 MiB raw
  maximum plus object overhead). Nations/humans are prioritized (up to 448), then
  up to 64 leading tribes. Old samples compact progressively; this is a bounded
  overview of the whole match, not a lossless economic archive.
- Queries return at most seven series; the client requests at most once per ten
  seconds for an unchanged selection. Metric/sort changes request fresh leaders.
- Restricted fog views receive only their own historical statistics and no global
  historical events. Corridor geometry requires visibility of the full route.
  Reconstructing historical foreign visibility is explicitly not implemented.

## Evidence

- Broad server suite: 547 tests / 85 files pass.
- Focused regression suite: 165 tests / 14 files pass.
- Added host-level test confirms unattended history is reconstructed identically
  after journal recovery. Host/history rerun: five tests pass.
- Client chart/dashboard suite: 13 tests pass, including fresh-device pre-join
  history replacement. TypeScript passes; production Vite build passes.
- Build warnings remain for optional stone textures, large bundles and a mixed
  static/dynamic import. No iPhone/Expo visual validation claimed.
- `scripts/benchmark-late-game-caches.ts`: isolated 1,000-query fixture with
  3,000 owners, 500 ports and 1,000 cities: port enumeration 405.09 to 8.24 ms;
  unit-price counting 1.86 to 0.083 ms. Matching result checksums. These are NOT
  whole-server TPS improvements or an overnight acceptance test.
- `scripts/audit-maritime-passages.ts`: shipped 12,324 x 5,844 HD map has bounded
  local water connectivity through both Panama and Suez. Native routes were
  34 and 59 tiles respectively, inside their local test regions. This does not
  guarantee AI destination selection uses those passages frequently.

## Still required

1. New-world soak with a surviving human, larger fleets and increased trade.
   Compare tick p50/p95/p99, clock debt, memory and late mobile reconnects.
2. Use the new synchronous-route diagnostics for another late-game profile;
   caching repeated failures does not eliminate first-time synchronous searches.
3. Verify actual normal replay export against the configured archive service;
   UUID validation tests do not prove the remote service is available.
4. iPhone/Expo visual check: leave and rejoin, open a different device, change
   graph metric/timescale, inspect established lanes without waiting for traffic.

The steady-10-TPS goal is not yet proven. Increased traffic is not evidence of
headroom; the next longplay must measure it. No production deployment requested.

## Preview rollout

Loaded 27 scoped runtime files into the preview checkout, retaining prior copies
under `.dev-logs/backups/server-history-20260928`. Restarted preview on September
28 at approximately 18:32 UTC after verifying zero active matches (two older
scheduled lobbies retained). Both workers became ready and `/api/health` returned
`ok`. Preview TypeScript and production build both passed. The public landing
page returns 200; the public health route correctly requires preview login.
Existing local cosmetics-service connection warnings remain. No production push,
match creation, journal deletion, or iPhone visual verification performed.
