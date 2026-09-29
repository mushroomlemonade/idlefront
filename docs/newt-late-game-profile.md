# Newt late-game investigation — 2026-09-28

Implementation follow-up: [server history and profiling recommendations](server-world-history.md).
The findings below describe Newt before those changes; they are not post-fix measurements.

## Scope and preserved evidence

User authorized profiling and then closing this match. No gameplay changes,
restarts, or other-world termination performed.

- World `world_YFGrS8rpEoUDZKG_`, game `LkZ2XEVs`, name `Newt`.
- Map `Expanded Earth XL HD v1`, 3,000 bots, Medium nations, strategy v2.
- Persisted corridor switches: shared-v2 water routing, route-v1 maturation,
  shared-v1 warship routing. Fleet automation v26.3, patrol scheduling v1.
- Source telemetry: preview `.dev-logs/managed/Backend-2026-09-27T21-55-09-410Z.log`.
- Private development captures: `.dev-logs/profiles/LkZ2XEVs-1790603090030.cpuprofile`
  and `LkZ2XEVs-start-1790603153026.json`. Do not publish the raw identity data.
- Preview backup: `.data/backups/newt-before-retirement-1790603220462.sqlite`.
- Closed through the normal worker `endManagedGame` lifecycle at 13:48:31 UTC.
  Database phase finished; journal retained through turn 540966 (540967 turns).
  Backend health remains OK. No journals deleted.
- Normal archive FAILED: invalid UUID at `info.players[0].persistentID`.
  This needs a separate identity/archive compatibility fix; the retained journal
  and starting state are not equivalent to a verified normal replay export.
- Shutdown's `Simulation stopped` error occurred after the intentional end;
  do not count it as an overnight spontaneous failure.

## Longplay performance

Before backup/retirement, 15.51 wall hours produced 14.99 simulation hours:
roughly 30.7 minutes behind. No logged spontaneous simulation/delivery failures
in the 15.47-hour health report. This is useful stability evidence, NOT a pass
for steady 10 TPS or human-client memory/reconnection requirements.

| Period (simulation age) | Median rolling TPS, no viewers |
| ----------------------- | -----------------------------: |
| 0–1h                    |                          10.00 |
| 3–4h                    |                           8.33 |
| 8–9h                    |               10.93 (catch-up) |
| 14–15h                  |                           9.81 |

Recent pre-backup window: p50 about 90ms, p95 211ms, p99 802ms, max 945ms.
Whole-run worst rolling TPS 5.90; worst rolling p99 1785ms. Typical ticks are
much healthier than the old 1-TPS collapse, but recurring tail latency remains.
Peak shared worker-process RSS about 3.13GB (decimal), not client memory.
Late sample: 333 warships, 892 trade ships, 2 transports, 1604 SAMs.
The logged global warship peak across sampled entries was 542.

### Human participation limitation

At 14–15 simulation hours, 27 telemetry entries with viewers had median rolling
TPS 9.33 vs 9.81 across 333 no-viewer entries. These are overlapping rolling
windows, not matched A/B measurements. Viewers may be eliminated spectators.
Do not attribute the entire difference to networking or extrapolate multiplayer
capacity. A surviving human can add combat, fleet size, explosions, changing
territory and routing churn; client rendering and reconnect snapshots add costs
that this simulation-only profile does not measure. Peak recorded view queue
was about 39MB; its client-visible consequences were not reproduced here.

## 25.34-second live simulation-thread V8 sample

Exclusive categories; routing removed from caller buckets to prevent double
counting. Sampling gaps >10ms are unattributed. Percentages are sampled wall
time of ONE simulation thread, not whole-server CPU. Background route-worker
CPU is excluded; idle can include waiting for their results.

| Category                      | Sample share |
| ----------------------------- | -----------: |
| Synchronous routing           |        18.4% |
| Nation construction/upgrades  |        15.1% |
| Ports/trade-partner selection |        11.7% |
| Warships excluding routing    |         5.9% |
| View encoding/snapshots       |         3.7% |
| Rail/trains                   |         3.0% |
| Other nation decisions        |         0.7% |
| Other simulation/runtime      |        15.8% |
| Garbage collection            |         1.7% |
| Idle/waiting                  |        22.6% |
| Unattributed sampling gaps    |         1.3% |

Rounded percentages may not total exactly 100. Construction's hot stack runs
through upgrade candidate checks into Config cost calculations. Port execution
repeatedly enumerates trade-compatible players/ports and sorts candidates.
Synchronous repair remains despite background preparation. Frequent route-not-
found/patrol failures were logged. One sample is not a comprehensive causal
breakdown of all overnight hitches or guaranteed optimization savings.

Reproduce report: `scripts/report-newt-profile.mjs LOG GAME_ID PROFILE`.

## Why visible corridors disappoint

The configured routing optimizations are enabled. The visible layer, however,
is NOT a projection of the server's established corridors:

- `TradeTraffic` starts empty on each client session and accumulates observed
  trade ship/train movement only. No historical route heat in a late join.
- `GameView` resets ALL traffic history on fog unit reset, any packed terrain
  update, or railroad destruction, rather than invalidating just damaged areas.
- Only 12,000 distinct segment edges survive; on a huge map, churn can evict
  edges before enough repeat traffic raises their prominence. This eviction
  impact is an inference from the bounded implementation, not measured client
  telemetry from the user's phone.
- It draws no warship traffic. Lanes are cosmetic overlays, not terrain channels.
- Water shared routing reuses paths/nearby connectors; it does not create canals
  or deliberately direct all global traffic through named strategic chokepoints.

Both normal and paged renderers have the draw pass, so a missing paged-map draw
implementation is not the issue. No device-level visual validation performed.
Panama/Suez passability and actual traversed paths were NOT established by this
CPU sample; audit the map's water connectivity before promising either route.

## Trade density and fleet limits

`Config.tradeShipSpawnRate` scales density for literal map names `Expanded Earth
Ultra` (16) and `Expanded Earth XL` (4), otherwise 1. Newt's HD map name matches
neither: it uses base-map scaling. Traffic multiplier is 1. This is a verified
map-name mismatch, not a measured guarantee of how much traffic should increase.
Correct scale must come from validated map metadata, not an invented multiplier.

`NationStrategy` explicitly caps automatic replenishment target at 48. Its
smaller strategic fleet target caps at 8. Native/reactive spawning still exists,
so 48 is not a universal hard engine unit limit. The policy substantially limits
what this AI-only soak demonstrates about larger human fleets.

## Recommended next work (not implemented in this diagnostic pass)

1. Reduce repeated build affordability/upgrade scans and port candidate rebuilds
   with deterministic tick-local caching and appropriate invalidation. Re-profile.
2. Capture failed route fixtures and eliminate repeated failed searches; measure
   background preparation wait separately from synchronous core routing.
3. Replace client-observed lane memory with bounded authoritative route summaries
   in snapshots/deltas, permission-filtered and locally invalidated. Render those
   same routes prominently without new UI. Verify canals on the actual map.
4. After headroom exists, fix map density metadata and replace the nation-only 48
   target cap with economy/threat/coverage-based budgets, preserving ordinary
   prices. Test increased traffic/fleets plus a living human and mobile reconnect.

Also fix archive identity validation before claiming full replay export support.
Do not increase unit counts first and mistake this lighter AI soak for proof of
headroom. A steady 10-TPS acceptance test still needs bounded tick tails, no growing
clock debt, client memory/network checks, and active-player late-game coverage.
