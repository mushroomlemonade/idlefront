# Independent source repository

This repository starts with a source snapshot of IdleFront v26.4, with updated
project attribution and source links. It intentionally does not import earlier
Git commit metadata. OpenFront's copyright, license terms, asset credits and
upstream attribution remain intact.

Canonical source: https://github.com/mushroomlemonade/idlefront

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
