import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import type { Config } from "../../core/configuration/Config";
import { EventBus } from "../../core/EventBus";
import { GameMode, GameType, PlayerType, UnitType } from "../../core/game/Game";
import { GameUpdateType } from "../../core/game/GameUpdates";
import { UserSettings } from "../../core/game/UserSettings";
import { ActionableEvents } from "../hud/layers/ActionableEvents";
import { ControlPanel } from "../hud/layers/ControlPanel";
import { GameLeftSidebar } from "../hud/layers/GameLeftSidebar";
import { GameRightSidebar } from "../hud/layers/GameRightSidebar";
import { PlayerInfoOverlay } from "../hud/layers/PlayerInfoOverlay";
import { SettingsModal } from "../hud/layers/SettingsModal";
import { UnitDisplay } from "../hud/layers/UnitDisplay";
import "../styles/hud-reference.css";
import type { TransformHandler } from "../TransformHandler";
import type { UIState } from "../UIState";
import type { GameView, PlayerView } from "../view";
import type { AtlasGameHud } from "./AtlasGameHud";

/** UI-only fixture, loaded exclusively through ?ui-lab=hud. It feeds the REAL
 * controllers through their public interface; no sockets, game creation,
 * background simulation or replacement gameplay renderer. */
export function createHudReferenceGame(): GameView {
  const levels = new Map([
    [UnitType.City, 8],
    [UnitType.Factory, 3],
    [UnitType.Port, 4],
    [UnitType.DefensePost, 6],
    [UnitType.MissileSilo, 2],
    [UnitType.SAMLauncher, 1],
    [UnitType.Warship, 3],
  ]);
  const player = (
    id: number,
    name: string,
    troops: number,
    gold: bigint,
  ): PlayerView =>
    ({
      id: () => `reference-${id}`,
      smallID: () => id,
      displayName: () => name,
      name: () => name,
      clanTag: () => null,
      troops: () => troops,
      gold: () => gold,
      team: () => null,
      type: () => (id === 1 ? PlayerType.Human : PlayerType.Nation),
      isPlayer: () => true,
      isAlive: () => true,
      isFriendly: () => false,
      isAlliedWith: () => false,
      isOnSameTeam: () => false,
      isLobbyCreator: () => false,
      isTraitor: () => false,
      isDisconnected: () => false,
      isRequestingAllianceWith: () => false,
      inDoomsdayClock: () => false,
      hasEmbargo: () => false,
      getTraitorRemainingTicks: () => 0,
      outgoingAttacks: () => [],
      outgoingEmojis: () => [],
      transitiveTargets: () => [],
      alliances: () => [],
      units: () => [],
      numTilesOwned: () => (id === 1 ? 340_000 : 220_000),
      totalUnitLevels: (type: UnitType) => levels.get(type) ?? 0,
      profile: async () => ({ relations: {} }),
      cosmetics: {},
      buildables: async () => [],
    }) as unknown as PlayerView;
  const me = player(1, "You", 2_140_000, 1_700_000n);
  const other = player(2, "Franche-Comté", 1_860_000, 2_000_000n);
  const config = {
    gameConfig: () => ({ gameType: GameType.Public, gameMode: GameMode.FFA }),
    isReplay: () => false,
    isUnitDisabled: () => false,
    maxTroops: () => 3_990_000,
    troopIncreaseRate: () => 4_850,
    donateTroops: () => false,
    doomsdayClockConfig: () => undefined,
    allianceExtensionPromptOffset: () => 600,
    allianceRequestDuration: () => 600,
  } as unknown as Config;
  return {
    config: () => config,
    myPlayer: () => me,
    playerViews: () => [me, other],
    playerBySmallID: (id: number) => (id === 1 ? me : other),
    player: () => other,
    owner: () => other,
    inSpawnPhase: () => false,
    ticks: () => 13_520,
    elapsedGameSeconds: () => 1_352,
    gameID: () => "UI-DEMO",
    updatesSinceLastTick: () => null,
    numLandTiles: () => 1_000_000,
    numTilesWithFallout: () => 0,
    isValidCoord: () => true,
    isTileVisible: () => true,
    ref: () => 1,
  } as unknown as GameView;
}

@customElement("atlas-hud-reference")
export class AtlasHudReference extends LitElement {
  private info?: PlayerInfoOverlay;
  private notices?: ActionableEvents;

  createRenderRoot() {
    return this;
  }

  async firstUpdated() {
    const hud = document.querySelector<AtlasGameHud>("atlas-game-hud");
    if (!hud) return;
    await hud.updateComplete;
    const game = createHudReferenceGame();
    const eventBus = new EventBus();
    const uiState: UIState = {
      attackRatio: 0.2,
      ghostStructure: null,
      rocketDirectionUp: false,
      upgradeMultiplier: 1,
    };
    const panel = hud.querySelector<ControlPanel>("control-panel")!;
    panel.game = game;
    panel.eventBus = eventBus;
    panel.uiState = uiState;
    panel.init();
    panel.tick();
    const units = hud.querySelector<UnitDisplay>("unit-display")!;
    units.game = game;
    units.eventBus = eventBus;
    units.uiState = uiState;
    units.init();
    units.tick();
    const left = hud.querySelector<GameLeftSidebar>("game-left-sidebar")!;
    left.game = game;
    left.eventBus = eventBus;
    left.init();
    const right = hud.querySelector<GameRightSidebar>("game-right-sidebar")!;
    right.game = game;
    right.eventBus = eventBus;
    right.init();
    right.tick();
    this.info = hud.querySelector<PlayerInfoOverlay>("player-info-overlay")!;
    this.info.game = game;
    this.info.eventBus = eventBus;
    this.info.transform = {
      screenToWorldCoordinates: () => ({ x: 1, y: 1 }),
    } as unknown as TransformHandler;
    this.info.init();
    this.notices = hud.querySelector<ActionableEvents>("actionable-events")!;
    this.notices.game = game;
    this.notices.eventBus = eventBus;
    this.notices.uiState = uiState;
    this.notices.tick();
    const settings = hud.querySelector<SettingsModal>("settings-modal")!;
    settings.eventBus = eventBus;
    settings.userSettings = new UserSettings();
    settings.init();
  }

  private showInvitation() {
    this.notices?.onAllianceRequestEvent({
      type: GameUpdateType.AllianceRequest,
      requestorID: 2,
      recipientID: 1,
      createdAt: 13_520,
    });
  }

  render() {
    return html`
      <img
        class="atlas-hud-reference__map"
        src="/maps/france/thumbnail.webp"
        alt="Static map backdrop for UI review, not a live match"
      />
      <nav class="atlas-hud-reference__tools" aria-label="HUD preview states">
        <span>UI preview · no live match</span>
        <div>
          <button
            class="atlas-hud-button atlas-hud-button--text"
            type="button"
            @click=${() => this.info?.maybeShow(0, 0)}
          >
            Player info
          </button>
          <button
            class="atlas-hud-button atlas-hud-button--text"
            type="button"
            @click=${this.showInvitation}
          >
            Invitation
          </button>
          <a class="atlas-hud-button atlas-hud-button--text" href="/">Done</a>
        </div>
      </nav>
    `;
  }
}

export function mountHudReference() {
  document.body.classList.add("in-game", "atlas-hud-reference-active");
  // Explicit browser-only test fixture. Real Expo insets come from its bridge.
  if (new URLSearchParams(location.search).get("safe-area") === "iphone") {
    document.body.dataset.referenceSafeArea = "iphone";
  }
  document.body.append(document.createElement("atlas-hud-reference"));
}
