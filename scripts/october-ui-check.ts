// Isolated synthetic UI/GPU fixture; never joins or changes a live match.
import { LeaderboardDashboard } from "../src/client/hud/layers/LeaderboardDashboard";
import {
  HISTORY_METRICS,
  LeaderboardHistory,
} from "../src/client/hud/layers/lib/LeaderboardHistory";
import { TradeCorridorPass } from "../src/client/render/gl/passes/TradeCorridorPass";
import "../src/client/styles.css";
import "../src/client/styles/war-room.css";
import type { GameView } from "../src/client/view";
import { UnitType } from "../src/core/game/Game";
const language = document.createElement("lang-selector");
Object.assign(language, {
  currentLang: "en",
  translations: Object.fromEntries(
    HISTORY_METRICS.map((c) => [c.labelKey, c.id]),
  ),
});
document.body.append(language);
const names = [
  "Namibia",
  "My iPhone",
  "Türkiye",
  "Nigeria",
  "Greenland",
  "Quebec",
];
const players = Array.from({ length: 100 }, (_, i) => ({
  id: () => `nation${i}`,
  name: () => names[i] ?? `Nation ${i}`,
  clanTag: () => null,
  isAlive: () => true,
  isOnSameTeam: () => false,
  numTilesOwned: () => 1000000 - i * 8000,
  gold: () => BigInt(2e6 + i * 17000),
  troops: () => 100000 - i * 800,
  allies: () => [],
  betrayals: () => 0,
  totalUnitLevels: () => 100 - i,
  units: () => [
    {
      type: () => UnitType.City,
      level: () => 100 - i,
      isActive: () => true,
      isUnderConstruction: () => false,
    },
  ],
}));
const game = {
  players: () => players,
  myPlayer: () => players[1],
  numLandTiles: () => 1e8,
  numTilesWithFallout: () => 0,
  config: () => ({ maxTroops: () => 1e6, gameConfig: () => ({}) }),
} as unknown as GameView;
const history = new LeaderboardHistory();
for (let t = 0; t <= 600; t += 5)
  history.sample(
    t * 10,
    players.map((p, i) => ({
      id: p.id(),
      name: p.name(),
      values: new Map(
        HISTORY_METRICS.map((c, j) => [
          c.id,
          (100 - i) * (t + 10) * (j + 1) * (t > 530 && i === 0 ? 0.6 : 1),
        ]),
      ),
    })),
  );
history.events.push(
  { tick: 5300, kind: "nuke", text: "Namibia: mirv detected" },
  { tick: 5350, kind: "capture", text: "12 structures changed hands" },
);
const dashboard = new LeaderboardDashboard();
dashboard.game = game;
dashboard.history = history;
dashboard.open = true;
document.body.classList.add("atlas-theme", "in-game");
const hud = document.createElement("atlas-game-hud");
const surface = document.createElement("div");
surface.className = "atlas-top-command-surface";
const sidebar = document.createElement("game-left-sidebar");
sidebar.append(dashboard);
surface.append(sidebar);
hud.append(surface);
document.body.append(hud);
const canvas = document.createElement("canvas");
const gl = canvas.getContext("webgl2");
const result = document.createElement("output");
result.id = "gpu-result";
if (gl) {
  const pass = new TradeCorridorPass(gl);
  pass.update(new Float32Array([0, 0, 1, 1, 0.7, 1]));
  pass.draw(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), 1);
  result.textContent = `corridor shader error: ${gl.getError()}`;
  pass.dispose();
} else result.textContent = "no webgl2";
document.body.append(result);
