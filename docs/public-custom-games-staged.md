# Public custom games — activated 2026-09-08

Activated after the user authorized stopping active games. The notes below describe the original staging procedure, not current deployment status. The live source now includes these changes and an experimental UHD Earth 27× custom preset. Production has not been pushed.

Prepared 2026-09-08 while the user was actively playtesting.
The running game backend and live application source were not restarted or replaced.

## Implementation

- Worlds menu: **make a lobby** and **custom game**, without the debug quick-launch panel.
- Custom wizard: Great Lakes (10x ships / 10x trains), Enormous Earth 16x area (5x / 5x), HD Earth 9x area (5x / 5x).
- All custom presets retain the existing 15x attack slowdown. Economy modifiers are presented using labelled ship, train and attack symbols.
- Custom rooms use an explicit persisted host-start mode, not a lobby-name prefix or fake countdown.
- Only the authenticated host may start. Repeated start requests are idempotent.
- Custom waiting rooms remain joinable and do not age out through the scheduled-world sweep.
- Scheduled games use the fixed 4x-area Earth board (2x width / height), standard economy and attack speed, FFA and the existing 1d pacing target. Actual conquest rules and simulation mechanics are unchanged.
- Scheduled launches still happen at their scheduled timestamp; their host cannot bypass the schedule.
- Clients waiting in a lobby enter when it activates and its runtime is ready. Returning to an already active lobby retains its Play action.
- Existing persisted runtime configurations/journals are reused, not regenerated with new presets.
- Diagnostic/developer features remain private; only game creation is public.

## Location and verification

Staged source: sibling directory `../idlefront-custom-games-staged/`.
Apply-ready delta against the current dirty checkout: `docs/public-custom-games.patch`.
The patch deliberately includes only this task's 18 changed/new files, preserving previous uncommitted work.

- TypeScript no-emit check passed.
- 57 focused server/lifecycle/account/password/notification/wizard tests passed (8 files).
- New coverage includes host authorization over HTTP, exact scheduled launch, repeated starts, long-idle custom rooms, cancellation, invalid presets, public wizard steps and accessible modifier symbols.
- Broader pre-existing boundary test fails on the phrase “Persistent-world” in a GameServer comment; reproduced against the unchanged live checkout. This task does not edit GameServer or weaken that test.
- Automated browser visual inspection was attempted but the isolated preview timed out. Final visual sign-off remains pending. The temporary preview process was stopped.
- Live local API health responded OK after preparation.
- HD Earth remains experimental: the previously documented bank-clipping pathfinder issue is not fixed by this UI/lifecycle work.

## Activation at the next user-approved playtest break

1. Confirm the user has ended their active test. Do not restart merely because this patch exists.
2. Verify the current checkout has not diverged: `git apply --check --ignore-space-change docs/public-custom-games.patch`.
3. Back up the persistent-world SQLite database using a consistent SQLite backup, including live WAL state; do not copy a live main database file alone.
4. Apply with `git apply --ignore-space-change docs/public-custom-games.patch`.
5. Run the focused tests and TypeScript check from the real checkout.
6. Restart only the managed backend once safe, allowing the additive schema-8 migration. Start/refresh the web preview and finish desktop/mobile visual inspection.
7. Check new custom room creation, a non-host cannot start, host Start provisions and enters the runtime, and a scheduled room launches on time.
8. Do not overwrite old world terrain or runtime configurations; do not cancel games unless separately authorized.

Schema 8 adds `start_mode` and `game_preset` to persistent_worlds. Older server code rejects schema 8; rollback requires the pre-migration database backup as well as source, or a deliberately reviewed compatible rollback. Do not silently downgrade an active database.

## Staging environment note

Moving the temporary staging folder with PowerShell followed a dependency junction before the move failed. Moved dependency payloads were restored without replacing newer files, and jsdom imports plus the complete focused test run were rechecked afterward. The source was copied to the sibling staging directory instead; duplicate temporary test files inside the live repo were renamed with a non-test suffix so normal test discovery remains clean. No live server was restarted. Temporary recovery copies remain in the staging directory; do not treat them as deliverables.
