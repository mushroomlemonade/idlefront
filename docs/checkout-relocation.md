# Development checkout locations

## Current source location

Canonical repository: https://github.com/mushroomlemonade/idlefront (`main`).
The clean-history publication checkout on the current Windows workstation is
`C:\Users\Administrator\Documents\checkout\idlefront-public`.
Runtime services have **not** been moved there by publishing the repository.
Use [repository migration](repository-migration.md) for the operator's cutover;
do not merge the old and new histories or run both against the same live data.

## Historical September 10 runtime relocation

As of September 10, 2026, the active checkout is:

`C:\Users\Administrator\Documents\checkout\idlefront`

The previous checkout remains as a recovery copy at `C:\Users\Administrator\Documents\Codex\2026-08-14\fork-openfront-project-to-start-work\openfront-idle`. Do not develop or run games against both copies: saved-game databases diverge after copying.

Robocopy completed with 83,957 files and 15.768 GiB copied, zero failures/mismatches. Git history and tracked changes were preserved. The original folder could not be renamed because another process held it open, so it was not deleted.

Backend and frontend startup from the new directory succeeded; backend reports all workers ready. Expo tunnel startup is still rejected by execution policy. Relocation is not proof of the original policy rejection's cause or a full resolution.
