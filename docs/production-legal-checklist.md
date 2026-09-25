# IdleFront production legal checklist

Status: pre-launch blockers, September 2026. This engineering checklist is not
legal advice; the operator should have counsel review the finished service and
mobile distribution before inviting the public or accepting payment.

## OpenFront derivative compliance

- Keep the complete covered work under AGPL v3 and preserve the upstream
  `LICENSE`, including its Section 7 additional terms.
- Show `© OpenFront and Contributors` in a reasonably visible title, splash,
  main-menu, or legal surface.
- Describe IdleFront as an independent modified version. Do not use OpenFront
  as the primary title or imply sponsorship, compatibility certification, or
  endorsement.
- Offer every network user a prominent, no-charge link to the exact
  corresponding source for the deployed commit. That source must include the
  scripts and interface material needed to build, install, run, and modify the
  covered version—not merely a link to upstream.
- Keep the deployed Git commit and source link together in release metadata so
  a later `main` branch cannot cease to describe an older running binary.

## Assets and upstream services

- Ship only repository `resources/` assets whose CC BY-SA attribution and
  share-alike obligations are represented in `LICENSE-ASSETS` and `CREDITS.md`,
  plus original or separately licensed IdleFront assets.
- Never build, copy, download, proxy, or cache OpenFront's `proprietary/`
  directory, premium assets, database content, CDN-only assets, music, skins,
  or cosmetics without separate written permission.
- Upstream integration comes from the public Git repository. IdleFront must
  not scrape OpenFront's live service or reuse its API keys, account database,
  analytics properties, advertising accounts, moderation endpoints, or
  production-only APIs.
- Review every upstream merge for new files, submodules, remote asset URLs,
  license changes, and additional notices before promotion.

## IdleFront-owned documents and data

- Replace the inherited OpenFront Terms of Service and Privacy Policy before
  any `idlefront.io` public launch. They name OpenFront Inc. as operator and
  cannot describe this service.
- Have counsel approve IdleFront's operator identity, governing terms, age
  gates, moderation/appeal path, payments, warranty language, and app-store
  disclosures. Configure working operator, privacy, security, and abuse email
  addresses on `idlefront.io`.
- Disclose account/guest identifiers, lobby membership, presence, chat,
  reminders, IP/server logs, and the map-tap anti-automation telemetry. State
  the 30-day raw-event and 90-day derived-risk retention targets, automated
  throttling/quarantine, review path, subprocessors, backups, and deletion
  behavior in the operator's own privacy notice.
- Do not enable email reminders until consent, unsubscribe/suppression,
  delivery-provider terms, and sender authentication are configured.
- Do not enable upstream Google Analytics, advertising, Cloudflare beacon, or
  ad-network identifiers. Production observability and analytics must use
  IdleFront-owned properties and must match IdleFront's consent policy.

## Name and distribution

- Obtain trademark clearance for `IdleFront` and its iconography separately
  from open-source-license compliance.
- Re-run this review for iOS/Android binaries: include the license/source path,
  CC BY-SA attribution, third-party notices, privacy manifest/data-safety
  declarations, and any installation-information obligations counsel finds
  applicable.
