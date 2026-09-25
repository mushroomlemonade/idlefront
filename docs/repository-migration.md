# Independent source repository

This repository starts with a source snapshot of IdleFront v26.4, with updated
project attribution and source links. It intentionally does not import earlier
Git commit metadata. OpenFront's copyright, license terms, asset credits and
upstream attribution remain intact.

Canonical source: https://github.com/mushroomlemonade/idlefront

## Checkout and commands

Use a fresh destination, not a live or recovery checkout:

```sh
git clone https://github.com/mushroomlemonade/idlefront.git idlefront
cd idlefront
npm run inst
```

The root scripts remain unchanged: `npm run dev`, `npm run start:client`,
`npm run start:server-dev`, `npm run start:idle-authority`, and
`npm run build-prod`. Choose the same backend entry point and environment as
your existing installation; do not switch server architectures during migration.
For Expo, install its separate dependencies with
`npm --prefix apps/mobile ci --ignore-scripts`, then use `npm run mobile:start`.
Keep `EXPO_PUBLIC_GAME_URL` pointed at your intended game server; a GitHub URL
is neither a game endpoint nor an Expo preview URL.

After a checkout has been created from this new repository, normal updates use
`git pull --ff-only origin main`. Do not run that migration command in the old
checkout, merge unrelated histories, or use a hard reset to replace local work.
Upstream links in credits and research remain intentional attribution.

## Startup configuration checklist

- Update deployment scripts' Git remote and source working directory to the
  fresh checkout. Update absolute paths in service units, scheduled task actions,
  process managers, build jobs and backup script locations where applicable.
- Preserve secret environment files and the existing database locations. A new
  checkout must not silently start a blank `.data` database or a second writer
  against the same database. Back up persistent state before the planned cutover.
- Keep existing `openfront-idle` service/container names and `/var/lib/openfront-idle`
  data paths unless performing a separately planned infrastructure migration.
  These compatibility names are not references to a personal GitHub account.
- Windows preview launchers read `Workspace` from their protected runtime JSON;
  scheduled tasks also embed absolute supervisor paths and working directories.
  Both must be reviewed together. See [managed startup](managed-dev-startup.md).
  Do not copy credentials into this public repository or run the installer simply
  to refresh documentation: it changes tasks and stops the existing gateway.
- Build with the new repository's actual commit ID (`git rev-parse HEAD`), not
  a historical release hash from the old checkout. Verify source links, health,
  reconnect, saved games and backups after the operator's cutover.
- GitHub Actions remain disabled. Secrets, environments, deploy keys, webhooks,
  packages and production integration were not copied. Before enabling CI,
  review the retained workflows; `release.yml` is inherited upstream machinery,
  not an IdleFront deployment procedure. `deploy.yml` only displays a notice.
  If enabling image publication through `idle-ci.yml`, configure the new GHCR
  namespace and the host's `IDLE_IMAGE_REPOSITORY` allowlist together; no image
  in that namespace is promised by publishing this source repository.

## Deployment gate

This repository is not automatically connected to production. Before deploying,
the operator must configure a fresh checkout of this repository, retain existing
runtime secrets and persistent data outside that checkout, and build with its
actual commit ID. Do not merge the unrelated histories or overwrite a running
checkout. Verify the live legal/source links resolve to the deployed commit.

Earlier running builds still point at their previous source repository. Keep
that source publicly accessible until those builds have been replaced or their
corresponding source has been provided through another working public link.
Changing the old repository's visibility beforehand breaks those source links
and may break an existing deployment pull process.

No game database migration or simulation change is included in this snapshot.
No deployment credentials, live match data, or local research artifacts are
intentionally included. Repository publication does not imply deployment.
