# OpenFront gameplay study and pacing guardrails

_Prepared August 26, 2026 for the future pacing-planning phase._

## Conclusion

OpenFront succeeds by turning a simple spatial action into a consequential
strategy decision:

> Click a bordering territory, commit a chosen share of troops, watch the
> border move, and become stronger geographically while becoming temporarily
> weaker militarily.

The map is the game. Economy, terrain, diplomacy, trade, naval power, and
nuclear deterrence deepen that loop without replacing it. Pressure Atlas must
keep that core intact. The UI may clarify and reskin it; later pacing work must
be a controlled series of small value experiments.

## Documented mechanics worth protecting

- Ground attacks are issued directly against bordering territory. The attack
  ratio controls committed troops, and additional clicks reinforce an existing
  attack. Overcommitting reduces growth and exposes the player.
  [Combat](https://openfront.wiki/Combat/)
- Troop generation is nonlinear and reaches its maximum gain near 42 percent
  of capacity. Land and cities contribute to the troop cap, creating the
  reserve-versus-expansion tension at the center of play.
  [Troops](https://openfront.wiki/Troops/)
- Terrain changes conquest cost and speed; mountains defend differently from
  plains. [Terrain](https://openfront.wiki/Terrain/)
- Border geometry matters because surrounded territory can be annexed nearly
  instantly and without troops. [Annexation](https://openfront.wiki/Annexation/)
- Trade is geographic. Income depends on infrastructure, alliances, route
  length, and piracy exposure. [Trade](https://openfront.wiki/Trade/),
  [Factories](https://openfront.wiki/Factory/),
  [Ports](https://openfront.wiki/Port/)
- Alliances are temporary and affect trade, donations, friendly fire, and
  warships. Betrayal carries visible combat penalties.
  [Alliances](https://openfront.wiki/Ally/)
- Cities, defense posts, ports, factories, warships, silos, SAMs, transports,
  and nuclear weapons create an escalation and counterplay ladder.
  [Buildings](https://openfront.wiki/Buildings/),
  [Warships](https://openfront.wiki/Warship/),
  [SAM launchers](https://openfront.wiki/SAM_Launcher/)
- Standard victory remains map-based at 80 percent of land; maps deliberately
  create different tempos and spatial puzzles.
  [Overview](https://openfront.wiki/OpenFront.io/),
  [Maps](https://openfront.wiki/Maps/)
- The Doomsday Clock is an example of a restrained late-game pacing tool: it
  waits before gradually pressuring weak sides to break stalemates.
  [Doomsday Clock](https://openfront.wiki/Doomsday_Clock/),
  [v0.33 release](https://github.com/openfrontio/OpenFrontIO/releases/tag/v0.33.0)

## Why the loop is engaging

The following are design inferences grounded in the documented mechanics and
recurring player feedback:

1. **Immediate, legible feedback.** Every important action changes the real
   map. UI that hides the map directly harms decision quality.
   [Player UI feedback](https://www.reddit.com/r/Openfront/comments/1rs5zuu/update_ui_eyesore_great_new_maps/)
2. **Easy input, difficult judgment.** Clicking is trivial; choosing the target,
   timing, route, and committed percentage is not. Players discuss multiple
   viable openings rather than one fixed sequence.
   [Early-game discussion](https://www.reddit.com/r/Openfront/comments/1tjpyx5/why_am_i_so_bad_at_earlygame/),
   [strategy discussion](https://www.reddit.com/r/Openfront/comments/1vbnw1f/what_is_the_best_early_game_strat/)
3. **A natural match arc.** Wilderness expansion leads into capacity and
   income, then diplomacy and target selection, then naval/economic contest,
   and finally coalition or nuclear escalation.
4. **Map-dependent strategy.** Terrain, coastlines, chokepoints, islands, and
   neighbors make the same rules produce different matches.
5. **Player-authored political stories.** Lightweight alliances, donations,
   betrayal, deterrence, and retaliation produce memorable events without a
   separate diplomacy simulator.
   [Alliance story](https://www.reddit.com/r/Openfront/comments/1u07n14/my_ally_nuked_himself_when_i_was_getting_invaded/)
6. **Leader counterplay.** Land creates a deliberate snowball, while alliances,
   trade, naval attacks, fortification, and nuclear weapons provide ways to
   resist it.
7. **Low entry friction.** It runs in a browser and on phones, and its common
   multiplayer population is part of the product value. The publisher and a
   commercial partner report substantial player counts, though those claims
   are not independently audited.
   [Steam listing](https://store.steampowered.com/app/3560670/OpenFront/),
   [Playwire case study](https://www.playwire.com/case-studies/openfront-io)

## Recurring pain points to measure, not immediately redesign

- Opening volatility and spawn dependence.
- Land-driven snowballing that can erase later agency.
- Late-game stalemates caused by fortification, island economies, naval
  defense, and mutual nuclear deterrence.
  [Stalemate report](https://www.reddit.com/r/Openfront/comments/1sy77lz/1hr_stalemate/)
- Comeback states that can be either too weak to matter or too entrenched to
  finish.
- Hidden knowledge around growth efficiency, terrain, trade, and alliance
  consequences.
- Mobile panels covering the map or requiring extra steps for frequent actions.
  [Mobile feedback](https://www.reddit.com/r/Openfront/comments/1olgvyi/mobilefront_woes/)

## Product and gameplay invariants

- The authentic OpenFront map remains the dominant interaction surface.
- Clicking territory remains a strategic troop commitment, not uncapped
  clicks-per-second damage.
- The troop reserve and growth curve remains meaningful.
- Terrain, borders, annexation, coastlines, and infrastructure placement retain
  their strategic value.
- The opening-to-economy-to-diplomacy-to-escalation arc remains recognizable.
- Alliances stay lightweight, temporary, consequential, and risky.
- Conventional, naval, economic, defensive, and nuclear systems continue to
  counter one another.
- Frequent actions stay contextual and fast, especially on mobile.
- Defense posts, factories, and road networks—their mechanics and present
  balance—are explicitly frozen by the user for the next pacing phase.
- Persistent/offline play, AFK rules, and tap-pressure are separate mode-level
  design questions, not small baseline pacing tweaks.

## Conservative experiment ladder

1. Begin with values already exposed by lobby configuration: game length, gold
   multiplier, starting gold, alliance duration, PvP immunity, and
   tribe/nation density.
2. Change one value family per playtest and make it adjustable without a
   rebuild when practical.
3. Consider narrow timing or cost experiments only after the baseline is
   measured: base gold rate, selected build duration, alliance timing, selected
   movement/reload/repair timing, late-game pressure timing, or spawn
   protection.
4. Treat troop growth, capacity, casualty ratios, conquest rewards, terrain,
   defense multipliers, trade payouts, and SAM/nuke economics as high-risk
   coupled systems even when the code change looks numeric and small.
5. Do not combine a baseline pacing test with persistent worlds, AFK immunity,
   CPS combat, annexation changes, victory-condition changes, or permanent
   progression.

## Live playtest measurements

Compare every experiment with an unchanged baseline and record:

- time to first border conflict;
- opening survival and spawn abandonment;
- troop reserve at major attacks;
- land concentration over time;
- first and median elimination time;
- match duration and stalemate frequency;
- comeback frequency and duration;
- actions per minute by phase and device class;
- alliance formation, betrayal, and renewal timing;
- mobile abandonment and UI obstruction reports.

The exact user prompt governing this phase is pinned at the top of
[`handoff.md`](../handoff.md).
