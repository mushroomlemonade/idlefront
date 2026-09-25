# Continuous pressure implementation

## Native demo milestone — 2026-09-20

### Native growth adapter and population HUD

New quickplay defaults to populationGrowthMultiplier=1. Config.troopIncreaseRate
now accepts an optional population argument, defaulting to the original troop
count. Its native arithmetic/capacity/type/difficulty logic is unchanged. Pressure
growth passes civilians + available military + deployed military, all weighted
1:1; births enter civilians and over-cap donations are not destroyed. Missing
multiplier retains the previous logistic model for saved games. Longplay/idlefront
defaults have not been retuned in this quickplay-focused pass.

The creation UI exposes native growth multiplier for new quickplay. Actual
gross births/sec are sent from the authority to the HUD, separately from conversion
or casualties. Restored a labelled growth indicator, actual allocation split, and
stacked civilians/available/deployed population-capacity meter. Mobilisation still
uses its existing shared half-life pending the separate conversion UX/rate pass.

73 targeted tests passed, including native equivalence at equal population for
all three player types, deployed population, over-cap conservation and HUD rates.
1x/200 bots/107 nations/1800 ticks: mean 5.90ms, p99 12.0ms, max 23.0ms, zero
ticks above100ms. This is headless early-game performance, not a longplay claim.
Typecheck retains only the four previously documented test/declaration errors.
Backend restarted after verifying no connected players. Fresh quickplay needed.

Next valuable human checkpoint: quickplay growth/recovery, allocation clarity,
and contested pressure after the 3-minute grace. Remaining broader work includes
conversion multiplier/target-marker polish, prolonged pressure balance, cross-device
visual/reconnect validation and larger-map performance. No production push.

### Playtest correction in progress

Update after user approval: implemented explicit `passiveWildernessExpansion`
on newly provisioned pressure worlds. Automatic wilderness forces retain troop
strength while conquering; native terrain/speed/traversal remain unchanged.
Manual wilderness and all contested attacks retain normal casualties. Forces
are still committed/debited, cannot be demobilised in flight, and return normally.
Manual and passive attacks cannot merge. Both reference and worker wilderness
planners carry the new classification and match authoritative execution in tests.
Absent config retains old behaviour for existing saved games/replays.

114 focused tests passed. Same 1x Earth seed, 307 players, 1,800 game ticks:
before changes population min/median/max 156/524/30261; with passive expansion
and the 3-minute grace period 1378/18748/30261. New mean tick 5.26ms, p99 11.9ms,
max 17.7ms, no ticks over 100ms. This is an early-game headless measurement only.
Grace countdown is shown in the mobilisation panel. Backend reload performed
only after the user's test match reported zero connected clients; fresh games
are required for these rules. No saved game resets or production push.

User screenshots show military/civilian totals collapsing, not merely a desired
pacing adjustment. Mobilisation-only 1,800-tick regression conserves total
population under alternating 87%/2% targets. Automatic pressure currently
reuses casualty-consuming AttackExecution even for wilderness (16–24 troops per
tile for humans/nations), at up to 8% free troops per game second, while population
growth replaced native rapid troop regeneration. This is an integration defect
in the automatic expansion model; the grace period alone does not resolve it.
The legacy +troops/s HUD readout is now suppressed for pressure games because it
advertised regeneration that no longer runs. Need agreement on wilderness
casualties for passive expansion before changing this core rule.

Separately implemented, not yet backend-deployed: pressureGraceSeconds per new
preset (180/1200/3600), measured since actual spawn-phase end; only bots/wilderness
remain targetable during it. Includes manual/automatic attacks, warships via
canAttackPlayer, nuclear direct/splash checks, and transport landing checks.
75 focused tests passed including exact grace boundaries and mobilisation
conservation. No backend restart during this active playtest.

This section supersedes the foundation-pass limitations below. New quickplay,
longplay and idlefront worlds now opt into `continuousPressure: v1`; existing
saved runtime configurations are not rewritten.

- Native PlayerExecution owns civilian growth and gradual mobilisation, replacing
  direct army regeneration in this mode. Deployed attacks/transports count as
  military and cannot be demobilised while committed. Donations remain native
  immediate troop transfers. Actual civilian share multiplies passive, train,
  and trade-ship income by 1–2x.
- Slider intents change the target, not the current army. Manual and AFK
  conversion use the same half-life. Bots/disconnected players respond to incoming
  attacker ratios; connected humans become eligible after 60 game seconds without
  an intent. This inactivity threshold is an initial implementation choice.
- Initial civilians equal the starting army (50% military). Population capacity
  uses the existing native capacity formula. Growth never deletes an over-cap
  donation. Initial numeric defaults need human playtesting.
- Native AttackExecution changes ownership. Cached contact counts are invalidated
  by nearby ownership/terrain changes. Once per game second, staggered players
  allocate at most 8% of free troops proportionally to eligible frontier length.
  Near-balanced fronts skip new attacks (5% hysteresis). Existing attacks finish
  natively; this is a first pressure model, not continuous per-tile rebalancing.
- Alliances persist after protection ends. Protection is 5/30/720 minutes;
  breaking afterwards always triggers betrayal. Mutual extensions add another
  protection period. Offline allies remain friendly. Nuclear protection and
  allied transport landings are guarded too.
- Custom creation exposes the two pacing controls; scheduled creation derives
  them from duration. Native player snapshots/diffs include population state;
  deterministic turn replay reconstructs the simulation-side state.

Validation:

- 57 focused foundation/integration tests passed, followed by 99 tests covering
  pressure, attacks, disconnection, nuclear execution, trains and trade ships
  (overlapping suites; do not sum these counts).
- Two 1x Earth/200-bot/107-nation runs at 1,200 ticks produced identical final
  hash 912979706633205. Early p99 approximately 10ms.
- 18,000 simulation ticks (30 game minutes), 307 starting players: mean 14.7ms,
  p95 38.3ms, p99 54.0ms, max 136ms, 4 ticks over 100ms, peak heap 215MB.
  End state had 3,692 units. This is headless, excludes network/mobile rendering,
  and does not establish performance at 9x/27x. Existing failed ship-path retry
  messages remain visible in the mature-world harness and warrant later profiling.
- TypeScript reports only the four pre-existing wilderness-test/private hash and
  supervisor/proxy declaration errors; global typecheck is not green.
- Restarted only the development backend after verifying zero connected clients
  in the previous world. Live API creation, gameplay-identity binding, host start
  and worker config confirmed the new pressure rules on Giant World Map with 200
  bots. QA matches were ended; saved user worlds were not deleted.

Next gate: human iPhone/desktop quickplay feedback on slider usability, expansion,
front balance, diplomacy and reconnect. No connected Chrome/IAB automation surface
was available for visual inspection, so mobile visual behaviour is not certified.
No production deployment or commit performed in this pass.

Authoritative specification: `continuous-pressure-implementation.txt`.
Desktop copy: `C:/Users/Administrator/Desktop/Idlefront-continuous-pressure-implementation.txt`.
Starting recovery commit: `567752e371a4f38d3622a0951c650522a6adc982`.

## First foundation pass

- New-game UI: quickplay / longplay / idlefront, Earth 1x / 9x / 27x.
- Scheduled creation now honours selected duration instead of forcing one day
  and the old 4x preset. Custom duration follows its selected preset.
- Historical preset identifiers remain readable for saved worlds and older
  clients. Existing persisted runtime configs retain their original terrain.
- Shared preset metadata records protection of 5 minutes / 30 minutes / 12 hours.
  These new protection semantics are NOT active yet: native alliances still
  automatically expire and need coordinated authority/UI changes.
- Pure population accounting kernel implements game-time mobilisation with a
  shared half-life, committed-troop demobilisation floor, immediate conserved
  donation, and a proposed bounded 1x–2x actual-civilian income curve.
  The kernel is tested but is NOT yet integrated into PlayerImpl or income events.

## Next implementation gates

1. Add opt-in, persisted pressure-rule configuration and the two pacing controls
   through custom-world schema/storage, runtime config and setup UI. Choose and
   document initial presets; no separate automatic conversion-speed control.
2. Integrate civilians and conserved total military accounting into the native
   player lifecycle, attacks, transport, losses, donations and view snapshots.
   The existing engine currently regenerates troops directly; simply adding
   mobilisation alongside that would create population incorrectly.
3. Replace expiry with breakable continuing alliances for pressure games and
   enforce protection at all hostile entry paths, then extension and betrayal.
4. Add bounded native frontier pressure, threat-driven target selection and AFK
   state. Stable-front caching must account for growth/mobilisation changes.
5. Add compact target/current slider, civilian income integration and resettable
   1x authoritative scenario. Test end-to-end, measure cadence and mobile frames,
   and verify Atlas/Expo links before calling it ready for playtesting.

No backend restart, production deployment, or active-game reset was performed
in this foundation pass. New menu choices may hot reload in the dev client.

## Pacing persistence pass

Added validated `pressurePacing` to world creation, durable SQLite world records,
lobby responses and runtime configuration. Migration is additive and existing
worlds retain absent pacing fields. Scheduled games reject overrides and resolve
their mode defaults; custom games can supply the same two bounded controls.
These fields remain tuning metadata until the native population integration is
complete; their presence alone does not alter existing simulation rules.

Initial proposed defaults (game seconds, subject to playtesting):

| Mode      | Uncapped population doubling time | Shared mobilisation half-life |
| --------- | --------------------------------: | ----------------------------: |
| quickplay |                               600 |                             5 |
| longplay  |                              7200 |                            10 |
| idlefront |                             86400 |                          3600 |

40 focused tests passed across population accounting, world service, runtime
configuration and repository persistence. The existing project-wide TypeScript
errors remain in wilderness-planner and supervisor/proxy declaration tests.
Atlas's Expo SDK 57 manifest and launch-bundle endpoint returned HTTP 200 during
the pass. This checks delivery, not an actual iPhone launch or pressure gameplay.
No game server restart was performed.
