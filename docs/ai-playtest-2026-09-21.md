# Pressure AI playtest checkpoint

Development only; production has not been updated.

- Personality-based land campaigns retain targets, reserve defenders, retreat
  through native executions, and recover between offensives.
- AI military targets rise for offensives; conversion still follows the shared
  pacing control. No population or gold is created by strategy.
- Structure affordability uses real cost plus a 25% cash cushion instead of
  an escalating hoarding threshold. Native build order, placement, density,
  construction costs, and upgrade rules remain. A failed defense-post search
  no longer blocks every other development option in pressure mode.
- Naval decisions recur approximately every 30–40 game seconds. They examine
  up to 12 opponents, validate at most two landing routes, and permit at most
  three active transports per AI. Nations can build up to four patrol warships.
- Follow-up waves revisit a landing; stalled/repeated objectives are temporarily
  avoided. Coast fallback scans and wilderness samples are bounded.

Validation: strategy, pressure conservation, naval, economy and existing nation
structure tests passed; TypeScript and changed-source lint passed.

Limits: landing progress is estimated using net territory growth, not a dedicated
beachhead ledger. Naval escorts are not coordinated formations. Bounded sampling
does not guarantee discovery of every possible coast. Existing games recover by
replay and may diverge under changed AI rules. Fleet/pathfinding load and actual
late-game conquest behavior still require a sustained playtest.
