import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { Config } from "../../../core/configuration/Config";
import { EventBus } from "../../../core/EventBus";
import {
  GameMode,
  GameType,
  Gold,
  PlayerBuildableUnitType,
  UnitType,
} from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import { UserSettings } from "../../../core/game/UserSettings";
import { ClientID } from "../../../core/Schemas";
import "../../components/AttackRatioDial";
import "../../components/FleetPanel";
import "../../components/PopulationRatioSlider";
import { Controller } from "../../Controller";
import { AttackRatioEvent, ToggleStructureEvent } from "../../InputHandler";
import { startStructureDrag } from "../../StructureDrag";
import { SendMobilisationIntentEvent } from "../../Transport";
import { UIState } from "../../UIState";
import {
  getGamesPlayed,
  renderNumber,
  renderTroops,
  translateText,
} from "../../Utils";
import { GameView } from "../../view";
import { PlayerView } from "../../view/PlayerView";
import {
  cityIcon,
  defensePostIcon,
  factoryIcon,
  goldCoinIcon,
  missileSiloIcon,
  portIcon,
  samLauncherIcon,
  soldierIcon,
} from "../HotbarIcons";

@customElement("control-panel")
export class ControlPanel extends LitElement implements Controller {
  public game: GameView;
  public clientID: ClientID;
  public eventBus: EventBus;
  public uiState: UIState;
  private readonly userSettings = new UserSettings();

  @state()
  private attackRatio: number = 0.2;
  @state() private mobilisationDraft: number | null = null;
  private mobilisationSendTimer: ReturnType<typeof setTimeout> | undefined;
  @state() private highlightedStructure: PlayerBuildableUnitType | null = null;

  @state()
  private _maxTroops: number;

  @state()
  private troopRate: number;

  @state()
  private _troops: number;

  @state()
  private _isVisible = false;

  @state()
  private _notification: { type: "warning" | "info"; message: string } | null =
    null;

  @state()
  private _gold: Gold;

  @state()
  private _attackingTroops: number = 0;

  @state()
  private _goldGain: bigint | null = null;
  @state()
  private _goldGainPulseId: number = 0;
  private _goldGainTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private _troopRateIsIncreasing: boolean = true;

  private _lastTroopIncreaseRate: number;

  // Border detection cache
  private _nearbyPlayerIDs: Set<number> = new Set();
  private _borderRefreshCounter: number = 0;
  private _borderTilesPromise: Promise<void> | null = null;
  // Track last attack tick per target player (for 15-second threshold)
  private _lastAttackTickByTarget: Map<number, number> = new Map();
  private static readonly BORDER_REFRESH_INTERVAL = 10; // recompute every 1s
  private static readonly ATTACK_THRESHOLD_TICKS = 15 * 10; // 15 seconds

  init() {
    this.eventBus.on(ToggleStructureEvent, (event) => {
      this.highlightedStructure =
        event.structureTypes?.length === 1 ? event.structureTypes[0] : null;
    });
    this.attackRatio = this.userSettings.attackRatio();
    this.uiState.attackRatio = this.attackRatio;
    this.eventBus.on(AttackRatioEvent, (event) => {
      let newAttackRatio = this.attackRatio + event.attackRatio / 100;

      if (newAttackRatio < 0.01) {
        newAttackRatio = 0.01;
      }

      if (newAttackRatio > 1) {
        newAttackRatio = 1;
      }

      if (newAttackRatio === 0.11 && this.attackRatio === 0.01) {
        // If we're changing the ratio from 1%, then set it to 10% instead of 11% to keep a consistency
        newAttackRatio = 0.1;
      }

      this.attackRatio = newAttackRatio;
      this.onAttackRatioChange(this.attackRatio);
    });
  }

  tick() {
    if (!this._isVisible && !this.game.inSpawnPhase()) {
      this.setVisibile(true);
    }

    const player = this.game.myPlayer();
    if (player === null || !player.isAlive()) {
      this.setVisibile(false);
      return;
    }

    this.updateTroopIncrease();

    const config = this.game.config();
    this._maxTroops = config.maxTroops(player);
    this._gold = player.gold();
    this._troops = player.troops();
    this._attackingTroops = player
      .outgoingAttacks()
      .map((a) => a.troops)
      .reduce((a, b) => a + b, 0);
    this.troopRate = config.troopIncreaseRate(player) * 10;

    const helpEnabled = new UserSettings().helpMessages();

    // Don't target veteran players
    if (helpEnabled && getGamesPlayed() < 20) {
      // Track outgoing attacks for 15-second threshold
      this.trackOutgoingAttacks(player);

      // Refresh border detection cache periodically
      this.refreshNearbyPlayers(player);

      // Compute notification
      this._notification = this.computeNotification(player, config);
    }

    const updates = this.game.updatesSinceLastTick();
    if (updates) {
      const myID = player.id();
      const bonusEvents = updates[GameUpdateType.BonusEvent];
      if (bonusEvents) {
        for (const ev of bonusEvents) {
          if (ev.player === myID && ev.gold > 0) {
            this.addGoldGain(BigInt(ev.gold));
          }
        }
      }
      const conquestEvents = updates[GameUpdateType.ConquestEvent];
      if (conquestEvents) {
        for (const ev of conquestEvents) {
          if (ev.conquerorId === myID && ev.gold > 0n) {
            this.addGoldGain(ev.gold);
          }
        }
      }
      const donateEvents = updates[GameUpdateType.DonateEvent];
      if (donateEvents) {
        for (const ev of donateEvents) {
          if (
            ev.donationType === "gold" &&
            ev.recipientId === myID &&
            ev.amount > 0n
          ) {
            this.addGoldGain(ev.amount);
          }
        }
      }
    }

    this.requestUpdate();
  }

  // Last-wins: when multiple gold events arrive in one tick, the pip shows
  // only the most recent amount (not a sum) — each gain restarts the pulse.
  private addGoldGain(amount: bigint) {
    this._goldGain = amount;
    this._goldGainPulseId++;
    if (this._goldGainTimeoutId !== null) {
      clearTimeout(this._goldGainTimeoutId);
    }
    this._goldGainTimeoutId = setTimeout(() => {
      this._goldGain = null;
      this._goldGainTimeoutId = null;
      this.requestUpdate();
    }, 2000);
  }

  private trackOutgoingAttacks(player: PlayerView) {
    const currentTick = this.game.ticks();
    for (const attack of player.outgoingAttacks()) {
      if (attack.targetID !== 0 && !attack.retreating) {
        this._lastAttackTickByTarget.set(attack.targetID, currentTick);
      }
    }
    // Clean up old entries
    for (const [playerID, tick] of this._lastAttackTickByTarget.entries()) {
      if (currentTick - tick > ControlPanel.ATTACK_THRESHOLD_TICKS * 2) {
        this._lastAttackTickByTarget.delete(playerID);
      }
    }
  }

  private refreshNearbyPlayers(player: PlayerView) {
    this._borderRefreshCounter++;
    if (
      this._borderRefreshCounter < ControlPanel.BORDER_REFRESH_INTERVAL ||
      this._borderTilesPromise !== null
    ) {
      return;
    }
    this._borderRefreshCounter = 0;
    this._borderTilesPromise = player.borderTiles().then((bt) => {
      this._borderTilesPromise = null;
      const myID = player.smallID();
      const nearby = new Set<number>();
      for (const tile of bt.borderTiles) {
        for (const neighbor of this.game.neighbors(tile as TileRef)) {
          const ownerID = this.game.ownerID(neighbor);
          if (ownerID !== 0 && ownerID !== myID) {
            nearby.add(ownerID);
          }
        }
      }
      this._nearbyPlayerIDs = nearby;
    });
  }

  private computeNotification(
    player: PlayerView,
    config: Config,
  ): { type: "warning" | "info"; message: string } | null {
    const currentTick = this.game.ticks();

    // Army limit warning
    const { gameMode, gameType } = config.gameConfig();
    const isPublicTeamGame =
      gameMode === GameMode.Team && gameType === GameType.Public;
    const canDonateTroops = config.donateTroops();
    if (isPublicTeamGame && canDonateTroops) {
      const ratio = this._troops / Math.max(this._maxTroops, 1);
      if (ratio >= config.armyLimitWarningThreshold()) {
        return {
          type: "warning",
          message: "control_panel.army_limit_warning",
        };
      }
    }

    // Low troops (Less than 1k) warning
    if (this._troops < 10000 && this._troops > 0) {
      return { type: "warning", message: "control_panel.low_troops_warning" };
    }

    // Info messages: check nearby players for traitors, AFK allies, AFK teammates
    for (const nearbyID of this._nearbyPlayerIDs) {
      let other;
      try {
        other = this.game.playerBySmallID(nearbyID);
      } catch {
        continue;
      }
      if (!other.isPlayer() || !other.isAlive()) continue;

      const lastAttackTick = this._lastAttackTickByTarget.get(nearbyID) ?? -1;
      const secondsSinceAttack = (currentTick - lastAttackTick) / 10;
      const hasNotAttackedRecently =
        lastAttackTick < 0 || secondsSinceAttack > 15;

      if (!hasNotAttackedRecently) continue;

      if (other.isTraitor() && player.isAlliedWith(other)) {
        return { type: "info", message: "control_panel.traitor_neighbor_info" };
      }
      if (other.isDisconnected() && player.isAlliedWith(other)) {
        return {
          type: "info",
          message: "control_panel.allied_afk_neighbor_info",
        };
      }
      if (other.isDisconnected() && player.isOnSameTeam(other)) {
        return {
          type: "info",
          message: "control_panel.teammate_afk_neighbor_info",
        };
      }
    }

    return null;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.highlightedStructure !== null) {
      this.eventBus?.emit(new ToggleStructureEvent(null));
      this.highlightedStructure = null;
    }
    clearTimeout(this.mobilisationSendTimer);
    this.mobilisationSendTimer = undefined;
    if (this._goldGainTimeoutId !== null) {
      clearTimeout(this._goldGainTimeoutId);
      this._goldGainTimeoutId = null;
    }
  }

  private updateTroopIncrease() {
    const player = this.game?.myPlayer();
    if (player === null) return;
    const troopIncreaseRate = this.game.config().troopIncreaseRate(player);
    this._troopRateIsIncreasing =
      troopIncreaseRate >= this._lastTroopIncreaseRate;
    this._lastTroopIncreaseRate = troopIncreaseRate;
  }

  onAttackRatioChange(newRatio: number) {
    this.uiState.attackRatio = newRatio;
  }

  setVisibile(visible: boolean) {
    this._isVisible = visible;
    this.requestUpdate();
  }

  private handleRatioDialInput(e: CustomEvent<{ value: number }>) {
    const value = e.detail.value;
    this.attackRatio = value / 100;
    this.onAttackRatioChange(this.attackRatio);
  }

  private calculateTroopBar(): { greenPercent: number; orangePercent: number } {
    const base = Math.max(this._maxTroops, 1);
    const greenPercentRaw = (this._troops / base) * 100;
    const orangePercentRaw = (this._attackingTroops / base) * 100;

    const greenPercent = Math.max(0, Math.min(100, greenPercentRaw));
    const orangePercent = Math.max(
      0,
      Math.min(100 - greenPercent, orangePercentRaw),
    );

    return { greenPercent, orangePercent };
  }

  private renderMobileTroopBar() {
    if (this.game?.myPlayer()?.pressure) return this.renderPopulationBar();
    const { greenPercent, orangePercent } = this.calculateTroopBar();
    return html`
      <div
        class="atlas-troop-meter w-full h-6 border border-gray-600 rounded-md bg-gray-900/60 overflow-hidden relative"
      >
        <div class="relative h-full">
          <div
            class="absolute inset-y-0 left-0 w-full origin-left bg-malibu-blue transition-transform duration-200 ease-out"
            style="transform: scaleX(${greenPercent / 100});"
          ></div>
          <div
            class="absolute inset-y-0 left-0 w-full origin-left bg-aquarius transition-transform duration-200 ease-out"
            style="transform: translateX(${greenPercent}%) scaleX(${
              orangePercent / 100
            });"
          ></div>
        </div>
        <div
          class="absolute inset-0 flex items-center justify-between px-1.5 text-xs font-bold leading-none pointer-events-none"
          translate="no"
        >
          <span class="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]"
            >${renderTroops(this._troops)}</span
          >
          <span class="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]"
            >${renderTroops(this._maxTroops)}</span
          >
        </div>
        <img
          src=${soldierIcon}
          alt=""
          aria-hidden="true"
          width="14"
          height="14"
          class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 brightness-0 invert pointer-events-none"
        />
      </div>
    `;
  }

  private renderDesktopTroopBar() {
    if (this.game?.myPlayer()?.pressure) return this.renderPopulationBar();
    const { greenPercent, orangePercent } = this.calculateTroopBar();
    return html`
      <div
        class="atlas-troop-meter w-full h-6 border border-gray-600 rounded-md bg-gray-900/60 overflow-hidden relative"
      >
        <div class="relative h-full">
          <div
            class="absolute inset-y-0 left-0 w-full origin-left bg-malibu-blue transition-transform duration-200 ease-out"
            style="transform: scaleX(${greenPercent / 100});"
          ></div>
          <div
            class="absolute inset-y-0 left-0 w-full origin-left bg-aquarius transition-transform duration-200 ease-out"
            style="transform: translateX(${greenPercent}%) scaleX(${
              orangePercent / 100
            });"
          ></div>
        </div>
        <div
          class="absolute inset-0 flex items-center text-lg font-bold leading-none pointer-events-none"
          translate="no"
        >
          <span class="flex-1 flex justify-end h-full items-center pr-0.5">
            <span class="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]"
              >${renderTroops(this._troops)}</span
            >
          </span>
          <span
            class="h-full flex items-center px-0.5 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]"
            >/</span
          >
          <span
            class="flex-1 flex justify-start h-full items-center pl-0.5 gap-0.5"
          >
            <span
              class="text-white tabular-nums w-[3.5rem] drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]"
              >${renderTroops(this._maxTroops)}</span
            >
            <img
              src=${soldierIcon}
              alt=""
              aria-hidden="true"
              width="22"
              height="22"
              class="shrink-0 brightness-0 invert drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)] ml-1.5"
            />
          </span>
        </div>
      </div>
    `;
  }

  private renderNotification() {
    if (!this._notification) return html``;
    const isWarning = this._notification.type === "warning";
    return html`
      <div
        class="flex items-center gap-1.5 px-1.5 py-1 rounded-md border text-xs font-medium mb-1 ${
          isWarning
            ? "border-orange-400/60 bg-orange-400/10 text-orange-300"
            : "border-blue-400/60 bg-blue-400/10 text-blue-300"
        }"
      >
        <span class="shrink-0" aria-hidden="true"
          >${isWarning ? "!" : "i"}</span
        >
        <span>${translateText(this._notification.message)}</span>
      </div>
    `;
  }

  private renderDesktop() {
    return html`
      <div class="atlas-desktop-control-layout">
        <!-- Row 1: troop rate | troop bar | gold -->
        <div class="atlas-resource-row flex gap-1.5 items-center mb-1">
          <!-- Troop rate -->
          <div
            style=${this.game?.config().gameConfig().continuousPressure ? "display:none" : ""}
            class="atlas-instrument-readout atlas-instrument-readout--rate flex items-center gap-1 shrink-0 border rounded-md font-bold text-sm py-0.5 px-1 w-[5.5rem] ${
              this._troopRateIsIncreasing
                ? "border-green-400"
                : "border-orange-400"
            }"
            translate="no"
          >
            <img
              src=${soldierIcon}
              alt=""
              aria-hidden="true"
              width="13"
              height="13"
              class="shrink-0"
              style="filter: ${
                this._troopRateIsIncreasing
                  ? "brightness(0) saturate(100%) invert(74%) sepia(44%) saturate(500%) hue-rotate(83deg) brightness(103%)"
                  : "brightness(0) saturate(100%) invert(65%) sepia(60%) saturate(600%) hue-rotate(330deg) brightness(105%)"
              }"
            />
            <span
              class="text-sm font-bold tabular-nums ${
                this._troopRateIsIncreasing
                  ? "text-green-400"
                  : "text-orange-400"
              }"
              >+${renderTroops(this.troopRate)}/s</span
            >
          </div>
          <!-- Troop bar -->
          <div class="atlas-resource-troops flex-1">
            ${this.renderDesktopTroopBar()}
          </div>
          <!-- Gold -->
          <div
            class="atlas-instrument-readout atlas-instrument-readout--gold flex items-center gap-1 shrink-0 border rounded-md border-yellow-400 font-bold text-yellow-400 text-sm py-0.5 px-1 min-w-[4.5rem] relative"
            translate="no"
          >
            ${
              this._goldGain !== null
                ? keyed(
                    this._goldGainPulseId,
                    html`<span
                      class="gold-gain-pop absolute -top-5 right-[5px] min-[1015px]:right-[9px] text-green-400 text-sm font-extrabold tabular-nums whitespace-nowrap pointer-events-none drop-shadow-[0_2px_3px_rgba(0,0,0,0.9)]"
                      >+${renderNumber(this._goldGain)}</span
                    >`,
                  )
                : ""
            }
            <img src=${goldCoinIcon} width="13" height="13" class="shrink-0" />
            <span class="tabular-nums">${renderNumber(this._gold)}</span>
          </div>
        </div>
        <attack-ratio-dial
          class="atlas-attack-dial--desktop"
          translate="no"
          .value=${Math.round(this.attackRatio * 100)}
          .step=${this.userSettings.attackRatioIncrement()}
          .label=${translateText("user_setting.attack_ratio_label")}
          .displayValue=${renderTroops(
            (this.game?.myPlayer()?.troops() ?? 0) * this.attackRatio,
          )}
          @attack-ratio-input=${this.handleRatioDialInput}
        ></attack-ratio-dial>
      </div>
    `;
  }

  private renderMobile() {
    return html`
      <div class="atlas-mobile-control-layout">
        <div class="atlas-mobile-control-ledger">
          <div class="atlas-mobile-ledger-row">
            <div
              class="atlas-instrument-readout atlas-instrument-readout--gold"
              translate="no"
            >
              ${
                this._goldGain !== null
                  ? keyed(
                      this._goldGainPulseId,
                      html`<span
                        class="gold-gain-pop absolute -top-5 right-[5px] min-[1015px]:right-[9px] text-green-400 text-xs font-extrabold tabular-nums whitespace-nowrap pointer-events-none drop-shadow-[0_2px_3px_rgba(0,0,0,0.9)]"
                        >+${renderNumber(this._goldGain)}</span
                      >`,
                    )
                  : ""
              }
              <img src=${goldCoinIcon} width="14" height="14" />
              <strong>${renderNumber(this._gold)}</strong>
            </div>
            <div
              style=${this.game?.config().gameConfig().continuousPressure ? "display:none" : ""}
              class="atlas-instrument-readout atlas-instrument-readout--rate"
              translate="no"
            >
              <img src=${soldierIcon} alt="" width="13" height="13" />
              <strong
                class=${
                  this._troopRateIsIncreasing
                    ? "text-green-400"
                    : "text-orange-400"
                }
                >+${renderTroops(this.troopRate)}/s</strong
              >
            </div>
          </div>
          <div class="atlas-mobile-troop-row">
            ${this.renderMobileTroopBar()}
          </div>
        </div>
        <attack-ratio-dial
          class="atlas-attack-dial--mobile"
          .value=${Math.round(this.attackRatio * 100)}
          .step=${this.userSettings.attackRatioIncrement()}
          .label=${translateText("user_setting.attack_ratio_label")}
          .displayValue=${renderTroops(
            (this.game?.myPlayer()?.troops() ?? 0) * this.attackRatio,
          )}
          @attack-ratio-input=${this.handleRatioDialInput}
        ></attack-ratio-dial>
      </div>
    `;
  }

  render() {
    return html`
      <style>
        @keyframes gold-gain-pop {
          0% {
            transform: translateY(4px);
            opacity: 0;
          }
          100% {
            transform: translateY(0);
            opacity: 1;
          }
        }
        .gold-gain-pop {
          animation: gold-gain-pop 0.25s ease-out;
        }
      </style>
      <div
        class="atlas-control-instruments relative pointer-events-auto ${
          this._isVisible ? "relative w-full text-sm px-2 py-1" : "hidden"
        }"
        @contextmenu=${(e: MouseEvent) => e.preventDefault()}
      >
        ${this.renderNotification()} ${this.renderMobilisation()}
        ${this._isVisible && this.game.config().gameConfig().fleetAutomation === "v26.3" ? html`<fleet-panel .game=${this.game} .eventBus=${this.eventBus} .tick=${Math.floor(this.game.ticks() / 10)}></fleet-panel>` : ""}
        ${
          !this.game?.myPlayer()?.pressure
            ? html`<div class="lg:hidden">${this.renderMobile()}</div>
                <div class="hidden lg:block">${this.renderDesktop()}</div>`
            : ""
        }
      </div>
    `;
  }

  createRenderRoot() {
    return this; // Disable shadow DOM to allow Tailwind styles
  }

  private renderMobilisation() {
    const pressure = this.game?.myPlayer()?.pressure;
    if (!pressure) return html``;
    const freeTroops = this.game.myPlayer()!.troops();
    const deployed = Math.max(0, pressure.military - freeTroops);
    const population = Math.max(1, pressure.civilians + pressure.military);
    if (this.mobilisationDraft === Math.round(pressure.target * 100))
      this.mobilisationDraft = null;
    return html`<div
      class="atlas-mobilisation-compact"
      style="display:grid;gap:4px;padding:2px 4px;color:inherit;font-size:12px"
    >
      ${pressure.automatic ? html`<div>auto-defending</div>` : ""}
      <style>
        .atlas-pressure-dials {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
          gap: 12px;
          align-items: center;
        }
        .atlas-pressure-dials .atlas-population-instruments {
          grid-column: 1;
          grid-row: 1;
          min-width: 0;
        }
        .atlas-pressure-dials .atlas-primary-attack {
          grid-column: 2;
          grid-row: 1;
        }
        body.atlas-theme.in-game
          .atlas-primary-attack
          .atlas-attack-dial__bezel {
          width: 104px;
          height: 104px;
          flex-basis: 104px;
        }
        body.atlas-theme.in-game
          .atlas-primary-attack
          .atlas-attack-dial__touchfield {
          min-height: 146px;
        }
        body.atlas-theme.in-game
          .atlas-primary-attack
          .atlas-attack-dial__needle {
          height: 38px;
        }
        body.atlas-theme.in-game
          .atlas-population-dial
          .atlas-attack-dial__bezel {
          width: 60px;
          height: 60px;
          flex-basis: 60px;
        }
        body.atlas-theme.in-game
          .atlas-population-dial
          .atlas-attack-dial__touchfield {
          min-height: 96px;
        }
        body.atlas-theme.in-game
          .atlas-population-dial
          .atlas-attack-dial__needle {
          height: 18px;
        }
        .atlas-structure-register {
          display: grid;
          grid-template-columns: repeat(6, minmax(0, 1fr));
          gap: 3px;
          border-top: 1px solid #ffffff20;
          padding-top: 5px;
        }
        .atlas-structure-register button {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          min-width: 0;
          min-height: 40px;
          padding: 2px;
          color: inherit;
        }
        .atlas-structure-register button[aria-pressed="true"] {
          background: #a8c7ad30;
          box-shadow: inset 0 0 0 1px #a8c7ad;
        }
        .atlas-structure-register button:first-child {
          border-bottom-left-radius: min(
            24px,
            var(--atlas-device-bottom-radius, 12px)
          );
        }
        .atlas-structure-register button:last-child {
          border-bottom-right-radius: min(
            24px,
            var(--atlas-device-bottom-radius, 12px)
          );
        }
        @media (min-width: 769px) {
          .atlas-structure-register {
            display: none;
          }
        }
      </style>
      <div class="atlas-pressure-dials">
        <population-ratio-slider
          class="atlas-primary-attack"
          .value=${this.attackRatio * 100}
          .min=${1}
          .available=${(100 * freeTroops) / Math.max(1, pressure.military)}
          .committed=${(100 * deployed) / Math.max(1, pressure.military)}
          label="attack"
          .barValue=${renderTroops(freeTroops * this.attackRatio)}
          .description=${`${renderTroops(deployed)} troops deployed`}
          @attack-ratio-input=${this.handleRatioDialInput}
        ></population-ratio-slider>
        <div class="atlas-population-instruments">
          <population-ratio-slider
            class="atlas-population-dial"
            .min=${0}
            .value=${this.mobilisationDraft ?? Math.round(pressure.target * 100)}
            label="troops"
            .barValue=${renderTroops(pressure.military)}
            .available=${(100 * freeTroops) / population}
            .committed=${(100 * deployed) / population}
            .description=${`${renderTroops(pressure.civilians)} civilians, ${renderTroops(pressure.military)} military`}
            @attack-ratio-input=${(e: CustomEvent<{ value: number }>) => {
              e.stopPropagation();
              this.mobilisationDraft = e.detail.value;
              if (this.mobilisationSendTimer) return;
              this.mobilisationSendTimer = setTimeout(() => {
                this.mobilisationSendTimer = undefined;
                if (this.mobilisationDraft !== null)
                  this.eventBus.emit(
                    new SendMobilisationIntentEvent(
                      this.mobilisationDraft / 100,
                    ),
                  );
              }, 100);
            }}
          ></population-ratio-slider>
        </div>
      </div>
      ${this.renderPopulationBar()} ${this.renderStructureRegister()}
    </div>`;
  }

  private renderStructureRegister() {
    const player = this.game.myPlayer();
    if (!player) return html``;
    const entries: [PlayerBuildableUnitType, string, string][] = [
      [UnitType.City, cityIcon, "city"],
      [UnitType.Factory, factoryIcon, "factory"],
      [UnitType.Port, portIcon, "port"],
      [UnitType.DefensePost, defensePostIcon, "defense_post"],
      [UnitType.MissileSilo, missileSiloIcon, "missile_silo"],
      [UnitType.SAMLauncher, samLauncherIcon, "sam_launcher"],
    ];
    return html`<div
      class="atlas-structure-register"
      aria-label="Structure counts"
    >
      ${entries.map(
        ([type, icon, key]) =>
          html`<button
            type="button"
            class="atlas-instrument-readout"
            aria-label=${`Highlight ${translateText("unit_type." + key)}`}
            aria-pressed=${this.highlightedStructure === type}
            title=${translateText("unit_type." + key)}
            style="touch-action:none"
            @pointerdown=${(event: PointerEvent) => startStructureDrag(event, type, this.eventBus)}
            @click=${(event: Event) => {
              event.stopPropagation();
              this.highlightedStructure =
                this.highlightedStructure === type ? null : type;
              this.eventBus.emit(
                new ToggleStructureEvent(
                  this.highlightedStructure
                    ? [this.highlightedStructure]
                    : null,
                ),
              );
            }}
          >
            <img src=${icon} width="18" height="18" alt="" /><span
              >${player.totalUnitLevels(type)}</span
            >
          </button>`,
      )}
    </div>`;
  }

  private renderPopulationBar() {
    const player = this.game.myPlayer()!;
    const pressure = player.pressure!;
    const population = pressure.civilians + pressure.military;
    const capacity = this.game.config().maxTroops(player);
    const denominator = Math.max(1, capacity, population);
    const civilians = (100 * pressure.civilians) / denominator;
    const available = (100 * player.troops()) / denominator;
    const deployed =
      (100 * Math.max(0, pressure.military - player.troops())) / denominator;
    return html`<div
      class="atlas-population-summary"
      style="min-width:0;font-size:12px;font-variant-numeric:tabular-nums"
    >
      <div
        style="display:flex;justify-content:space-between;gap:8px;padding:0 2px 3px"
      >
        <span
          >population${
            pressure.growthPerSecond !== undefined
              ? html` <span aria-label="Population growth per second"
                  >+${(pressure.growthPerSecond / 10).toLocaleString("en", { notation: "compact", maximumFractionDigits: 1 }).toLowerCase()}/sec</span
                >`
              : ""
          }</span
        ><span>capacity</span>
      </div>
      <div
        class="atlas-troop-meter"
        role="meter"
        aria-label="Total population"
        aria-valuetext=${`Population ${renderTroops(population)} of ${renderTroops(capacity)} capacity; civilians ${renderTroops(pressure.civilians)}, available military ${renderTroops(player.troops())}, deployed military ${renderTroops(Math.max(0, pressure.military - player.troops()))}`}
        aria-valuemin="0"
        aria-valuemax=${Math.max(population, capacity)}
        aria-valuenow=${population}
        style="position:relative;min-height:26px;overflow:hidden;border-radius:6px"
      >
        <div aria-hidden="true" style="position:absolute;inset:0;display:flex">
          ${[
            [civilians, "#547e6c"],
            [available, "#416789"],
            [deployed, "#977044"],
          ].map(
            ([width, color]) =>
              html`<span
                style="width:${width}%;background:${color};transition:width 200ms linear"
              ></span>`,
          )}
        </div>
        <div
          style="position:relative;display:flex;justify-content:space-between;gap:8px;padding:4px 8px;font-weight:600;color:#fff;text-shadow:0 1px 2px #000"
        >
          <span>${renderTroops(population)}</span
          ><span>${renderTroops(capacity)}</span>
        </div>
      </div>
    </div>`;
  }
}
