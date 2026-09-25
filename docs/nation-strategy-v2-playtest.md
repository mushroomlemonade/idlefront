# Nation strategy v2: playtest follow-up

Status: preview backend restarted with user approval on 2026-09-23. A new match is required.
Existing saved `v1` matches retain v1 decisions. No production deployment.

Pre-restart SQLite backup: `.data/recovery/before-nation-v2-1790206160631.sqlite`
(998,739,968 bytes). Both backend workers reported ready; public client-config,
Expo manifest and Expo bundle returned HTTP 200 after restart. Windows browser
automation was attempted using the installed browser but failed with desktop
access denied; this is not an iPhone/browser visual-validation claim.

## Changes

- Vulnerability scoring distinguishes an extremely depleted army from an ordinary favorable matchup. Decisions remain staggered and paced; alliances, grace and native combat still apply.
- Small exhausted wilderness fronts can receive reinforcements; peaceful expansion commits 25% rather than 12%. An incremental shared shoreline cache examines at most 256 cells per overseas decision instead of relying exclusively on random whole-world pixels. Ownership and terrain are rechecked before use; at most two transport-build queries per decision remain.
- Successful paid atom/hydro/MIRV launches notify the conquest planner. A legal strike target receives a three-paced-minute priority window. It does not bypass alliances, grace, troop reserves, transport legality or normal construction. MIRV children do not repeatedly reset the objective.
- Native warship spawning, retaliation and escorts remain available. **Additional** fleet replenishment uses the same authoritative orders and purchases as the player slider, with economy/port-limited goals capped at 48 automated target ships. This is not a cap on native reactive spawning. Native purchases revalidate resources; queued automation rechecks owned ships before purchasing.
- Nations' automatic fleet commands have a simulation-only entry point. Player fleet intents still reject non-human identities. Unchanged AI settings do not repeatedly reset pending construction.
- Small land pressure no longer applies embargo/rejection/full hostility to nations in v2. A push of at least 15% of the defender's available troops (minimum 100 simulation troops) remains significant. Transport landings use their committed troops, not the sender's remaining home army. Nuclear/betrayal rules are unchanged.
- Focus and idle share the command bar's top action row. Focus uses native camera recentering; idle retains existing cinematic/AFK semantics. Removed an empty status row, reduced nav padding, and rounded outer structure buttons. Defense/attack flyouts reserve the new top row and existing resource strip. Safe-area margins and existing touch placement exclusions remain.

## Verification

- 203 tests passed across strategy, fleet, pressure, diplomacy, nuclear, persistence and HUD suites. Changed-file ESLint/oxlint and TypeScript passed.
- TypeScript passed; production build passed (existing unresolved legacy stone texture references, dynamic import and bundle-size warnings remain).
- Dedicated tests cover extreme weakness scoring, wilderness reinforcement, nuclear objective selection, diplomatic significance, nation fleet authorization, spending/reserves, old-version isolation, deterministic defended-island conquest, and four-native-nation continental expansion.
- Small fixtures are correctness/regression evidence, not evidence that this AI beats skilled humans or runs well on 27x Earth.
- No connected browser/device was available. iPhone layout and cinematic entry require manual validation.

## Replay review limits

Read-only reconstruction of the local single-player playtest uses saved commands and v1 config. There are no recorded turn hashes, so it cannot be certified as an exact authoritative replay. Private match identifiers and diagnostic output stay under ignored `.data/reviews/`, not in source control. `scripts/review-nation-playtest.ts` takes an exact game ID, wall-time bound in seconds, and turn bound; it rejects multiplayer rosters whose original ordering it cannot establish.

The first bounded review reached 19 minutes. Around 4.5 minutes several non-allied neighboring nations had more than twice the human's available troops while pursuing other targets. At 19 minutes roughly 78,000 land tiles were unowned (not necessarily all reachable). These observations support opportunism and expansion changes, but do not by themselves prove each missed attack would have won.

The extended bounded pass processed 18,374 ticks in 650 seconds, reaching approximately 30 minutes of game time. Unowned land was still about 76,000 tiles at 30 minutes. Namibia remained allied to the human in that last snapshot; the recorded reconstruction showed five earlier atom launches by Namibia but did not reach the reported 33-minute MIRV betrayal. That specific incident remains unverified. Nuclear follow-through is supported by the code audit and real paid-launch regression tests, not by a claimed observation of that MIRV's aftermath.

## Playtest

1. Start a **new** quickplay match after preview restart; check persisted `nationStrategy: v2`.
2. Leave adjacent wilderness and spend a substantial army: observe reinforcement and opportunistic attacks without grace/alliance violations.
3. Observe a nation's nuclear launch and subsequent ground/naval objectives.
4. Compare small routine pressure with a substantial push for diplomatic response.
5. Check focus/idle, both flyouts and structure drag placement on iPhone; no overlap or loss of bottom safe area.
