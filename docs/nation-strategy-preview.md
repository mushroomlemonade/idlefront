# Native nation strategy preview — 2026-09-23

This documents the original v1 preview. The subsequent playtest follow-up is in
[nation-strategy-v2-playtest.md](nation-strategy-v2-playtest.md); v1 saves remain versioned.

## Activation

New quickplay, longplay and idlefront managed matches persist `nationStrategy:
"v1"`. Every nation uses it; humans and tribes do not. Existing runtimes retain
their stored config and legacy behaviour. No save migration or production push.
Fog games deliberately retain the existing AI: this full-information planner
must not introduce new hidden-state access into fog modes.

The development landing page says `v26.3 · nation ai preview`. Create a NEW
quickplay game in the Expo preview after the approved backend restart.

## Implemented

- Per-nation deterministic, pacing-scaled objectives: develop, defend, expand,
  conquer and invade. Shared plan coordinates native land/sea attacks, fleet
  preparation, construction reserves and alliance decisions.
- Scores territory/infrastructure, available enemy army, distraction, distance,
  incumbent target and large-rival pressure. No player/AFK-specific targeting.
- Progress tracking, target retention, reinforcement, native retreat on failed
  fronts, bounded failure cooldown and transport-wave limits.
- Overseas invasion transitions into inland conquest after landing; escort
  existing transports using native connected-water movement; replenish a useful
  fleet with normal construction. Unoccupied island discovery is bounded.
- Continue wilderness expansion while fighting, retain threatened home reserves,
  use the existing mobilisation curve, prioritize capacity and initial economic
  infrastructure, reserve funds for useful ships and an available nuclear strike.
- Do not ally away a current objective or perpetually renew with the last rival;
  the final alliance can only be broken through native execution after protection
  expires, with normal consequences. Existing personality UI remains unchanged.
- `nationStrategy(game, player).plan` exposes a compact developer-readable reason
  and phase. It is not a new HUD overlay or unbounded event log.

## Boundaries

The native combat, growth, costs, execution classes, terrain, pathfinding and
identity systems are unchanged. Nuclear target selection, reactive naval defense,
and sophisticated structure placement continue using existing helpers. This is
a heuristic first pass, not learned AI, guaranteed expert play, or a complete
economic forecast. Ships are selected by proximity/connectivity, not a new naval
tactical solver. No simultaneous whole-world planning or extra per-frame work.

Strategic decisions are spaced 40–59 ticks times mobilisation pace, with bounded
24-neighbor scoring, 12-player rotating naval samples, 128 fallback coast tiles
per sampled rival, two transport reachability queries, and 24 fleet placement
attempts. Existing native indexes/placement helpers still have their original
costs. Maximum own fleet target is eight, excluding existing reactive defenses.

## Verification

- 142 focused tests across 11 files passed, including native nation execution,
  four-nation continental expansion/investment/combat, diplomacy/grace, no duplicate
  same-tick orders, resource legality, deterministic scenario results and all three
  new-match configuration paths.
- TypeScript, focused ESLint/oxlint and `git diff --check` passed.
- Production build passed, with existing unresolved stone-image, mixed-import and
  chunk-size warnings. The preview itself serves the development client.
- Controlled 320×160 two-island comparison (normal native costs/combat, 4,000-tick
  cap, same initial endowments): old/new conquest 565/310 ticks without additional
  defense, and 2,896/447 ticks when the defender orders a warship at tick 130.
  These are full `NationExecution` runs, not the older scripted naval controller.
- Measured p95 tick cost in that tiny fixture was roughly 0.13–0.26 ms. Relative
  cost varies across the different trajectories; this is NOT Earth-scale or phone
  performance validation. Occasional native `path not found to target` diagnostics
  still occur. No claim of a zero-path-failure or broad win-rate gate.
- Preview backend restarted with approval; saved database backed up under
  `.data/recovery/before-nation-strategy-1790197362148.sqlite`. Both gameplay
  workers reported ready. Public authenticated backend, development client,
  iOS Expo manifest and native JS bundle returned HTTP 200. The development
  client contains the preview label. No on-device iPhone test was performed.

## Playtest

Start a new quickplay match. Compare opening expansion, civilian/military
mobilisation, investment, sustained land wars, overseas follow-through, and
whether surviving nations keep pursuing victory. Try a small army and exposed
infrastructure, but also a normal competitive opening. Report approximate game
time, nation names, and screenshots when a nation stalls or makes an obviously
bad commitment. This playtest is needed to assess macro strength on real Earth.
