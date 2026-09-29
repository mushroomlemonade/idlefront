# Population pacing parity

New longplay (9× Earth) and idlefront (27× Earth) worlds now explicitly select
the native OpenFront population-growth curve, like quickplay. Previously only
quickplay supplied `populationGrowthMultiplier`; the other defaults inadvertently
selected the legacy logistic/doubling-time implementation. Low starting population
then produced very small absolute growth despite large territorial capacity.

No native growth, capacity, troop-conversion or combat formula was rewritten.
Civilian and military population still count equally. New default native rate
multipliers are quickplay 1, longplay 1/12 and idlefront 0.01. Longplay retains the
old 12-fold relative pacing intent; idlefront uses the existing configurable
minimum. These are initial tuning values, not guaranteed game durations.
Custom native multipliers remain configurable. Existing configs without a
multiplier continue using the old formula for deterministic recovery and replay.
Existing active worlds and previously created lobbies are not migrated by this fix.

Runtime regression coverage now checks the real duration for each current preset,
its physical map, AI v2, fleet automation, wilderness expansion, donations, grace,
alliance protection and pacing. Previous AI coverage used 1h for every preset,
which failed to exercise the longer-duration growth defaults. Saved strategy
versions and fog-specific restrictions remain intentional compatibility boundaries.

Focused verification: 58 tests passed across population, continuous pressure,
runtime bridge and custom-world suites. These small fixtures verify rule selection
and accounting, not 9× performance or long-match balance.

Playtest after loading the updated preview code: create a new longplay lobby,
verify the setup displays a native growth multiplier, then watch population and
growth at low population. Compare total population with capacity, not only free
troops: mobilisation and troops committed to attacks affect the free-troop readout.
