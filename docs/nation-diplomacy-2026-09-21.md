# Nation-only strategy and readable diplomacy

New campaign strategy, naval planning and strategy-driven mobilisation now exclude
tribes. Nations use a stable identity-based profile for combat commitment, risk
tolerance, decision cadence, recovery and alliance limits. The authoritative
player profile exposes the matching name, aggression and description to the
existing nation details panel alongside its actual relationship toward the viewer.

Pressure-mode nations seek useful human/nation partners, reject distrustful or
traitorous partners, and proactively renew useful alliances. Invitations use a
60–70-second decision cooldown and 120-second partner retry interval. Candidates
include up to eight neighbors and four roster samples; alliance degree is bounded
by personality and surviving non-tribal opposition. Existing alliance and renewal
executions retain protection timers and betrayal rules.

Validation: 49 strategy/diplomacy/pressure/naval tests, 18 alliance/panel/observer
tests, TypeScript and changed-source lint passed. Vite bundle compiled successfully.
The deterministic 6-nation, 40k-tile land-only observer ran 6,000 ticks, built 52
cities/factories and formed four alliances; measured p99 approximately 0.6ms,
maximum approximately 7ms. This is a smoke test, not a large-world TPS benchmark.

Not implemented: rich diplomatic memory beyond existing relationships/betrayal
state, coordinated allied campaigns, bespoke economy policies per personality,
or large-world ocean observer validation. Mobile layout still needs device review.
