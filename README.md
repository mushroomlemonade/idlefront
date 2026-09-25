# IdleFront

IdleFront is a persistent multiplayer strategy game built as an
independent modified version of [OpenFront](https://github.com/openfrontio/OpenFrontIO).
It is not affiliated with, endorsed by, or an official product of OpenFront
Inc. This repository was modified by IdleFront contributors in 2026.

The inherited OpenFront strategy simulation remains focused on territorial
control, structures, alliances, and real-world geography. IdleFront adds
its own product identity, interface, and persistent multiplayer foundation.

OpenFront itself began as a fork/rewrite of WarFront.io. Credit to
https://github.com/WarFrontIO.

Canonical repository: [mushroomlemonade/idlefront](https://github.com/mushroomlemonade/idlefront).
Report IdleFront issues and propose changes here, not in the upstream repository.
GitHub Actions are currently disabled; upstream CI badges do not describe this build.
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Assets: CC BY-SA 4.0](https://img.shields.io/badge/Assets-CC%20BY--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-sa/4.0/)

## License

IdleFront and the inherited OpenFront source code are licensed under the
**GNU Affero General Public License v3.0**, including OpenFront's Section 7
additional terms.

The required copyright notice appears in the in-game loading screen and the
main-menu Legal & Source panel:

- Main menu: "© OpenFront and Contributors"
- Loading screen: "© OpenFront and Contributors"

Modified versions must preserve these notices in reasonably visible locations.

See the [LICENSE](LICENSE) for complete requirements.

For fork-specific disclosure and the corresponding-source offer, see
[NOTICE.md](NOTICE.md). For asset licensing, see
[LICENSE-ASSETS](LICENSE-ASSETS). For license history, see
[LICENSING.md](LICENSING.md).

The all-rights-reserved files formerly under `proprietary/` are intentionally
excluded from this standalone fork. Runtime music is disabled until
independently licensed tracks are available.

## 🌟 Features

- **Real-time Strategy Gameplay**: Expand your territory and engage in strategic battles
- **Alliance System**: Form alliances with other players for mutual defense
- **Multiple Maps**: Play across various geographical regions including Europe, Asia, Africa, and more
- **Resource Management**: Balance your expansion with defensive capabilities
- **Cross-platform**: Play in any modern web browser

## 📋 Prerequisites

- [npm](https://www.npmjs.com/) (v10.9.2 or higher)
- A modern web browser (Chrome, Firefox, Edge, etc.)

## 🚀 Installation

Moving an existing installation? Read [the repository migration guide](docs/repository-migration.md)
first. The new repository has independent history: changing an old checkout's
remote and running `git pull` is not a supported migration.

1. **Clone the repository**

   ```bash
   git clone https://github.com/mushroomlemonade/idlefront.git
   cd idlefront
   ```

2. **Install dependencies**

   ```bash
   npm run inst
   ```

   Do NOT use `npm install` nor `npm i` but instead use our `npm run inst`. It runs the safer `npm ci --ignore-scripts` to install dependencies exactly according to the versions in `package-lock.json` and doesn't run scripts. This can prevent being hit by a supply chain attack.

## 🎮 Running the Game

### Development Mode

Run both the client and server in development mode with live reloading:

```bash
npm run dev
```

This will:

- Start the webpack dev server for the client
- Launch the game server with development settings
- Open the game in your default browser (to disable this behavior, set `SKIP_BROWSER_OPEN=true` in your environment)

### Client Only

To run just the client with hot reloading:

```bash
npm run start:client
```

### Server Only

To run just the server with development settings:

```bash
npm run start:server-dev
```

### Standalone backend boundary

IdleFront development and production builds connect only to IdleFront-owned
services. The fork intentionally does not ship convenience commands for
connecting a modified client to OpenFront's hosted staging or production
services. Set `DOMAIN`, deployment secrets, and observability properties to
IdleFront-owned values when deploying.

The repository move does not rename npm commands, service names, database paths,
or network endpoints. For operator-managed hosting see
[operations](docs/idle-operations.md); for Windows preview startup see
[managed startup](docs/managed-dev-startup.md). Neither document implies that
production has already moved to this repository.

## 🛠️ Development Tools

- **Format code**:

  ```bash
  npm run format
  ```

- **Lint code with Oxlint and ESLint**:

  ```bash
  npm run lint
  ```

- **Lint and fix code with Oxlint and ESLint**:

  ```bash
  npm run lint:fix
  ```

- **Testing**
  ```bash
  npm test
  ```

## 🏗️ Project Structure

- `/src/client` - Frontend game client
- `/src/core` - Deterministic game simulation
- `/src/server` - Backend game server
- `/resources` - Static assets (images, maps, etc.)

## 🤝 Contributing

Contributions and translations are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, the approved-issue process, project governance, and translation info.
