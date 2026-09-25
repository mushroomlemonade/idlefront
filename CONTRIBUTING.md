# Contributing to IdleFront

Submit IdleFront issues and pull requests to
[mushroomlemonade/idlefront](https://github.com/mushroomlemonade/idlefront),
targeting `main`. IdleFront is independent of OpenFront. Upstream credits remain
in [CREDITS.md](CREDITS.md); upstream Discord membership, CLA tooling and issue
approval automation are not IdleFront contribution requirements.

Discuss substantial changes in an issue first. Keep changes focused, explain
the design and tests, and treat contributors respectfully. Review decisions belong
to this repository's maintainers. No external username or personal email is
required in a pull request.

## Local development

Use Node 24 and npm. Fork the canonical repository if you need your own push
destination, then clone that fork, or clone the canonical source directly:

```sh
git clone https://github.com/mushroomlemonade/idlefront.git
cd idlefront
npm run inst
git switch -c feature/your-change
npm run dev
```

`npm run inst` installs locked dependencies without package lifecycle scripts.
Client-only and development-server commands remain `npm run start:client` and
`npm run start:server-dev`. See [mobile setup](apps/mobile/README.md) for Expo.
Existing installations must follow [repository migration](docs/repository-migration.md)
rather than pulling unrelated history into a live checkout.

## Verification and review

- Follow the existing TypeScript, Oxlint, ESLint and Prettier conventions.
- Add regression tests, especially for deterministic simulation changes.
- Run relevant tests, `npm run lint`, and `npm run build-prod`. The full test
  command is `npm test`; report checks you could not run.
- Include screenshots for UI changes and distinguish device testing from mocks.
- Use the existing translation system. Submit IdleFront translation changes here;
  upstream Crowdin is a separate project.
- Preserve licensing, attribution, authoritative ownership, replay determinism
  and persistent-state compatibility.
- Never commit credentials, live databases or private preview links.

Push your branch to your fork or authorized remote and open a pull request
against `mushroomlemonade/idlefront:main`. Link related issues and describe your
verification. GitHub Actions are currently disabled: publication or a green
upstream badge is not evidence that this change passed CI.

## License

Code contributions use the [AGPL v3 license and additional terms](LICENSE).
Assets must respect [LICENSE-ASSETS](LICENSE-ASSETS) and include attribution.
Preserve the required OpenFront notices.
