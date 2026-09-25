# Upstream OpenFront compatibility report

Measured September 1, 2026 after fetching `upstream/main`.

| Ref                                            | Commit                                     |
| ---------------------------------------------- | ------------------------------------------ |
| IdleFront `main` before this application slice | `44524a8a31865b8758b2f780e15da1f36ad10582` |
| Common OpenFront baseline                      | `19ca3a1682644c8fffa3f34cf96c4e8606794565` |
| Current fetched `upstream/main`                | `9a6be707587dd1ecce7206b5969887244507d7ba` |

The histories are 11 IdleFront commits ahead and 148 upstream commits ahead of
the common baseline. Upstream changed 724 files across the whole comparison,
including 136 paths under the deterministic core, ordinary server lifecycle,
worker, or renderer boundary. This is a real compatibility release, not a
blind dependency bump.

## Promotion rule

The current upstream rules must become IdleFront's laws of physics. The safe
sequence is therefore:

1. commit the application-only persistent-world foundation with its boundary
   tests while it is independently reviewable;
2. merge the fetched upstream commit without rewriting published history;
3. resolve shell, authentication, build, and UI conflicts around upstream's
   implementation—never by retaining an older copied simulation rule;
4. preserve upstream versions of `src/core`, AI, structures, maps, renderer,
   ordinary match lifecycle, and their tests unless an application adapter is
   strictly required;
5. run upstream's complete typecheck/lint/test/build/replay/server suite plus
   IdleFront's persistent-world, no-scroll UI, license, and renderer-boundary
   suite; and
6. record the promoted upstream commit in deployed release metadata.

Upstream merges are human-approved because data migrations, protocol versions,
replay compatibility, asset licensing, and deployment configuration can change
even when a gameplay patch is intended to be behavior-preserving. Automation
may report drift and run the matrix, but it must not push physics changes
directly to production.
