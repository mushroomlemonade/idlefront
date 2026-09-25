import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { assetUrl } from "../../../core/AssetUrls";
import { EventBus } from "../../../core/EventBus";
import { MessageType, PlayerType, UnitType } from "../../../core/game/Game";
import {
  AttackUpdate,
  GameUpdateType,
  UnitIncomingUpdate,
} from "../../../core/game/GameUpdates";
import "../../components/FleetTargetSlider";
import { Controller } from "../../Controller";
import { themeProvider } from "../../theme/ThemeProvider";
import {
  GoToPlayerEvent,
  GoToPositionEvent,
  GoToUnitEvent,
} from "../../TransformHandler";
import {
  CancelAttackIntentEvent,
  CancelBoatIntentEvent,
  SendAttackIntentEvent,
  SendMobilisationIntentEvent,
} from "../../Transport";
import { UIState } from "../../UIState";
import { renderNumber, renderTroops, translateText } from "../../Utils";
import { GameView, PlayerView, UnitView } from "../../view";
import {
  allianceIcon,
  atomBombIcon,
  defensePostIcon,
  goldCoinIcon,
  hydrogenBombIcon,
  mirvIcon,
} from "../HotbarIcons";
import { getColoredSprite } from "../SpriteLoader";
import type { ActionableEvents } from "./ActionableEvents";
import type { EventsDisplay } from "./EventsDisplay";
const soldierIcon = assetUrl("images/SoldierIcon.svg");
const swordIcon = assetUrl("images/SwordIcon.svg");

@customElement("attacks-display")
export class AttacksDisplay extends LitElement implements Controller {
  public eventBus: EventBus;
  public game: GameView;
  public uiState: UIState;

  private active: boolean = false;
  private incomingBoatIDs: Set<number> = new Set();
  private spriteDataURLCache: Map<string, string> = new Map();
  @state() private _isVisible: boolean = false;
  @state() private incomingAttacks: AttackUpdate[] = [];
  @state() private outgoingAttacks: AttackUpdate[] = [];
  @state() private outgoingLandAttacks: AttackUpdate[] = [];
  @state() private outgoingBoats: UnitView[] = [];
  @state() private incomingBoats: UnitView[] = [];
  @state() private outgoingExpanded = false;
  @state() private incomingExpanded = false;
  @state() private goldExpanded = false;
  @state() private tickerTypes: MessageType[] = [];
  private alertHomes = new Map<
    HTMLElement,
    { parent: Node; next: ChildNode | null }
  >();
  private mobileLayout =
    typeof matchMedia === "function" ? matchMedia("(max-width: 1023px)") : null;
  private layoutChanged = () => this.requestUpdate();

  connectedCallback() {
    super.connectedCallback();
    this.mobileLayout?.addEventListener("change", this.layoutChanged);
  }

  private restoreAlerts() {
    for (const [alert, home] of this.alertHomes) {
      if (alert.tagName === "EVENTS-DISPLAY")
        (alert as EventsDisplay).tickerFilter = "all";
      home.parent.insertBefore(
        alert,
        home.next?.parentNode === home.parent ? home.next : null,
      );
    }
    this.alertHomes.clear();
  }

  protected willUpdate() {
    // Preserve the live controllers and their event history before Lit removes
    // the flyout. Never create duplicate notification controllers.
    this.restoreAlerts();
  }

  protected updated() {
    if (
      (!this.incomingExpanded && !this.goldExpanded) ||
      !this.mobileLayout?.matches
    )
      return;
    const details = this.querySelector(
      this.incomingExpanded ? ".atlas-defense-fronts" : ".atlas-flow-details",
    );
    const hud = this.closest("atlas-game-hud");
    if (!details || !hud) return;
    for (const alert of hud.querySelectorAll<HTMLElement>("events-display")) {
      if (this.goldExpanded && alert.tagName === "ACTIONABLE-EVENTS") continue;
      if (alert.tagName === "EVENTS-DISPLAY")
        (alert as EventsDisplay).tickerFilter = this.goldExpanded
          ? "gold"
          : "defense";
      if (!this.alertHomes.has(alert) && alert.parentNode) {
        this.alertHomes.set(alert, {
          parent: alert.parentNode,
          next: alert.nextSibling,
        });
        details.append(alert);
      }
    }
  }

  disconnectedCallback() {
    this.restoreAlerts();
    this.mobileLayout?.removeEventListener("change", this.layoutChanged);
    super.disconnectedCallback();
  }

  createRenderRoot() {
    return this;
  }

  init() {}

  tick() {
    this.active = true;
    const hud = this.closest("atlas-game-hud");
    this.tickerTypes = [
      ...(hud
        ?.querySelector<EventsDisplay>("events-display")
        ?.tickerEvents?.() ?? []),
      ...(hud
        ?.querySelector<ActionableEvents>("actionable-events")
        ?.tickerEvents?.() ?? []),
    ].map((event) => event.type);

    if (!this._isVisible && !this.game.inSpawnPhase()) {
      this._isVisible = true;
    }

    const myPlayer = this.game.myPlayer();
    if (!myPlayer || !myPlayer.isAlive()) {
      if (this._isVisible) {
        this._isVisible = false;
      }
      return;
    }

    // Track incoming boat unit IDs from UnitIncoming events
    const updates = this.game.updatesSinceLastTick();
    if (updates) {
      for (const event of updates[
        GameUpdateType.UnitIncoming
      ] as UnitIncomingUpdate[]) {
        if (
          event.playerID === myPlayer.smallID() &&
          event.messageType === MessageType.NAVAL_INVASION_INBOUND
        ) {
          this.incomingBoatIDs.add(event.unitID);
        }
      }
    }

    // Resolve incoming boats from tracked IDs, remove inactive ones
    const resolvedIncomingBoats: UnitView[] = [];
    for (const unitID of this.incomingBoatIDs) {
      const unit = this.game.unit(unitID);
      if (unit && unit.isActive() && unit.type() === UnitType.TransportShip) {
        resolvedIncomingBoats.push(unit);
      } else {
        this.incomingBoatIDs.delete(unitID);
      }
    }
    this.incomingBoats = resolvedIncomingBoats;

    this.incomingAttacks = myPlayer.incomingAttacks().filter((a) => {
      const t = (this.game.playerBySmallID(a.attackerID) as PlayerView).type();
      return t !== PlayerType.Bot;
    });

    this.outgoingAttacks = myPlayer
      .outgoingAttacks()
      .filter((a) => a.targetID !== 0);

    this.outgoingLandAttacks = myPlayer
      .outgoingAttacks()
      .filter((a) => a.targetID === 0);

    this.outgoingBoats = myPlayer
      .units()
      .filter((u) => u.type() === UnitType.TransportShip);

    this.requestUpdate();
  }

  private renderButton(options: {
    content: any;
    onClick?: () => void;
    className?: string;
    disabled?: boolean;
    translate?: boolean;
    hidden?: boolean;
  }) {
    const {
      content,
      onClick,
      className = "",
      disabled = false,
      translate = true,
      hidden = false,
    } = options;

    if (hidden) {
      return html``;
    }

    return html`
      <button
        class="${className}"
        @click=${onClick}
        ?disabled=${disabled}
        ?translate=${translate}
      >
        ${content}
      </button>
    `;
  }

  private emitCancelAttackIntent(id: string) {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;
    this.eventBus.emit(new CancelAttackIntentEvent(id));
  }

  private emitBoatCancelIntent(id: number) {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;
    this.eventBus.emit(new CancelBoatIntentEvent(id));
  }

  private emitGoToPlayerEvent(attackerID: number) {
    const attacker = this.game.playerBySmallID(attackerID) as PlayerView;
    this.eventBus.emit(new GoToPlayerEvent(attacker));
  }

  private getBoatSpriteDataURL(unit: UnitView): string {
    const owner = unit.owner();
    const key = `boat-${owner.id()}`;
    const cached = this.spriteDataURLCache.get(key);
    if (cached) return cached;
    try {
      const canvas = getColoredSprite(unit, themeProvider.current());
      const dataURL = canvas.toDataURL();
      this.spriteDataURLCache.set(key, dataURL);
      return dataURL;
    } catch {
      return "";
    }
  }

  private async attackWarningOnClick(attack: AttackUpdate) {
    const playerView = this.game.playerBySmallID(attack.attackerID);
    if (playerView !== undefined) {
      if (playerView instanceof PlayerView) {
        const attacks = await playerView.attackClusteredPositions(attack.id);
        const pos = attacks[0]?.positions[0];

        if (!pos) {
          this.emitGoToPlayerEvent(attack.attackerID);
        } else {
          this.eventBus.emit(new GoToPositionEvent(pos.x, pos.y));
        }
      }
    } else {
      this.emitGoToPlayerEvent(attack.attackerID);
    }
  }

  private handleRetaliate(attack: AttackUpdate) {
    const attacker = this.game.playerBySmallID(attack.attackerID) as PlayerView;
    if (!attacker) return;

    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;

    const counterTroops = Math.min(
      attack.troops,
      this.uiState.attackRatio * myPlayer.troops(),
    );
    this.eventBus.emit(new SendAttackIntentEvent(attacker.id(), counterTroops));
  }

  private renderIncomingAttacks() {
    if (this.incomingAttacks.length === 0) return html``;

    return this.incomingAttacks.map(
      (attack) => html`
        <div
          class="flex items-center gap-0.5 w-full bg-gray-800/92 backdrop-blur-sm sm:rounded-lg px-1.5 py-0.5 overflow-hidden"
        >
          ${this.renderButton({
            content: html`<span class="inline-flex items-center"
                ><img
                  src="${soldierIcon}"
                  class="h-4 w-4"
                  style="filter: brightness(0) saturate(100%) invert(27%) sepia(91%) saturate(4551%) hue-rotate(348deg) brightness(89%) contrast(97%)"
                />↓</span
              ><span class="ml-1">${renderTroops(attack.troops)}</span>
              <span class="truncate ml-1"
                >${(
                  this.game.playerBySmallID(attack.attackerID) as PlayerView
                )?.displayName()}</span
              >
              ${
                attack.retreating
                  ? `(${translateText("events_display.retreating")}...)`
                  : ""
              } `,
            onClick: () => this.attackWarningOnClick(attack),
            className:
              "text-left text-red-400 inline-flex items-center gap-0.5 lg:gap-1 min-w-0",
            translate: false,
          })}
          ${
            !attack.retreating
              ? this.renderButton({
                  content: html`<img
                    src="${swordIcon}"
                    class="h-4 w-4"
                    style="filter: brightness(0) saturate(100%) invert(27%) sepia(91%) saturate(4551%) hue-rotate(348deg) brightness(89%) contrast(97%)"
                  />`,
                  onClick: () => this.handleRetaliate(attack),
                  className:
                    "ml-auto inline-flex items-center justify-center cursor-pointer bg-red-900/50 hover:bg-red-800/70 sm:rounded-lg px-1.5 py-1 border border-red-700/50",
                  translate: false,
                })
              : ""
          }
        </div>
      `,
    );
  }

  private renderOutgoingAttacks() {
    if (this.outgoingAttacks.length === 0) return html``;

    return this.outgoingAttacks.map(
      (attack) => html`
        <div
          class="flex items-center gap-0.5 w-full bg-gray-800/92 backdrop-blur-sm sm:rounded-lg px-1.5 py-0.5 overflow-hidden"
        >
          ${this.renderButton({
            content: html`<span class="inline-flex items-center"
                ><img
                  src="${soldierIcon}"
                  class="h-4 w-4"
                  style="filter: brightness(0) saturate(100%) invert(62%) sepia(80%) saturate(500%) hue-rotate(175deg) brightness(100%)"
                />↑</span
              ><span class="ml-1">${renderTroops(attack.troops)}</span>
              <span class="truncate ml-1"
                >${(
                  this.game.playerBySmallID(attack.targetID) as PlayerView
                )?.displayName()}</span
              > `,
            onClick: async () => this.attackWarningOnClick(attack),
            className:
              "text-left text-aquarius inline-flex items-center gap-0.5 lg:gap-1 min-w-0",
            translate: false,
          })}
          ${
            !attack.retreating
              ? this.renderButton({
                  content: "×",
                  onClick: () => this.emitCancelAttackIntent(attack.id),
                  className: "ml-auto text-left shrink-0",
                  disabled: attack.retreating,
                })
              : html`<span class="ml-auto truncate text-aquarius"
                  >(${translateText("events_display.retreating")}...)</span
                >`
          }
        </div>
      `,
    );
  }

  private renderOutgoingLandAttacks() {
    if (this.outgoingLandAttacks.length === 0) return html``;

    return this.outgoingLandAttacks.map(
      (landAttack) => html`
        <div
          class="flex items-center gap-0.5 w-full bg-gray-800/92 backdrop-blur-sm sm:rounded-lg px-1.5 py-0.5 overflow-hidden"
        >
          ${this.renderButton({
            content: html`<span class="inline-flex items-center"
                ><img
                  src="${soldierIcon}"
                  class="h-4 w-4"
                  style="filter: brightness(0) saturate(100%) invert(62%) sepia(80%) saturate(500%) hue-rotate(175deg) brightness(100%)"
                />↑</span
              ><span class="ml-1">${renderTroops(landAttack.troops)}</span>
              ${translateText("help_modal.ui_wilderness")}`,
            className:
              "text-left text-aquarius inline-flex items-center gap-0.5 lg:gap-1 min-w-0",
            translate: false,
          })}
          ${
            !landAttack.retreating
              ? this.renderButton({
                  content: "×",
                  onClick: () => this.emitCancelAttackIntent(landAttack.id),
                  className: "ml-auto text-left shrink-0",
                  disabled: landAttack.retreating,
                })
              : html`<span class="ml-auto truncate text-aquarius"
                  >(${translateText("events_display.retreating")}...)</span
                >`
          }
        </div>
      `,
    );
  }

  private getBoatTargetName(boat: UnitView): string {
    const target = boat.targetTile();
    if (target === undefined) return "";
    const ownerID = this.game.ownerID(target);
    if (ownerID === 0) return "";
    const player = this.game.playerBySmallID(ownerID) as PlayerView;
    return player?.displayName() ?? "";
  }

  private renderBoatIcon(boat: UnitView) {
    const dataURL = this.getBoatSpriteDataURL(boat);
    if (!dataURL) return html``;
    return html`<img
      src="${dataURL}"
      class="h-5 w-5 inline-block"
      style="image-rendering: pixelated"
    />`;
  }

  private getBoatETA(boat: UnitView): string {
    const plan = this.game.motionPlans().get(boat.id());
    if (!plan) return "";

    const planSteps = plan.path.length;
    const planTicks = planSteps * plan.ticksPerStep;
    const planEndTick = plan.startTick + planTicks;

    const remainingTicks = planEndTick - this.game.ticks();
    if (remainingTicks <= 0) return "0s";
    const remainingMs = remainingTicks * this.game.config().msPerTick();
    const remainingSeconds = Math.ceil(remainingMs / 1000);

    // e.g. return 1s, 35s, 59s, 1m, 1m1s, 1m59s, 2m, etc
    const m = Math.floor(remainingSeconds / 60); // minutes
    const s = remainingSeconds % 60; // seconds
    return (m ? `${m}m` : "") + (s ? `${s}s` : "");
  }

  private renderBoats() {
    if (this.outgoingBoats.length === 0) return html``;

    return this.outgoingBoats.map(
      (boat) => html`
        <div
          class="flex items-center gap-0.5 w-full bg-gray-800/92 backdrop-blur-sm sm:rounded-lg px-1.5 py-0.5 overflow-hidden"
        >
          ${this.renderButton({
            content: html`${this.renderBoatIcon(boat)}
              <span class="inline-block min-w-[3rem] text-right"
                >${renderTroops(boat.troops())}</span
              >
              <span class="truncate text-xs ml-1"
                >${this.getBoatTargetName(boat)}</span
              >
              <span class="text-xs ml-1 text-slate-300"
                >${this.getBoatETA(boat)}</span
              >`,
            onClick: () => this.eventBus.emit(new GoToUnitEvent(boat)),
            className:
              "text-left text-aquarius inline-flex items-center gap-0.5 lg:gap-1 min-w-0",
            translate: false,
          })}
          ${
            boat.transportShipState().isRetreating
              ? html`<span class="ml-auto truncate text-aquarius"
                  >(${translateText("events_display.retreating")}...)</span
                >`
              : this.renderButton({
                  content: "×",
                  onClick: () => this.emitBoatCancelIntent(boat.id()),
                  className: "ml-auto text-left shrink-0",
                  disabled: boat.transportShipState().isRetreating,
                })
          }
        </div>
      `,
    );
  }

  private renderIncomingBoats() {
    if (this.incomingBoats.length === 0) return html``;

    return this.incomingBoats.map(
      (boat) => html`
        <div
          class="flex items-center gap-0.5 w-full bg-gray-800/92 backdrop-blur-sm sm:rounded-lg px-1.5 py-0.5 overflow-hidden"
        >
          ${this.renderButton({
            content: html`${this.renderBoatIcon(boat)}
              <span class="inline-block min-w-[3rem] text-right"
                >${renderTroops(boat.troops())}</span
              >
              <span class="truncate text-xs ml-1"
                >${boat.owner()?.displayName()}</span
              >
              <span class="text-xs ml-1 text-slate-300"
                >${this.getBoatETA(boat)}</span
              >`,
            onClick: () => this.eventBus.emit(new GoToUnitEvent(boat)),
            className:
              "text-left text-red-400 inline-flex items-center gap-0.5 lg:gap-1 min-w-0",
            translate: false,
          })}
        </div>
      `,
    );
  }

  private renderAttackGauge(
    direction: "incoming" | "outgoing",
    troops: number,
    count: number,
  ) {
    const incoming = direction === "incoming";
    const expanded = incoming ? this.incomingExpanded : this.outgoingExpanded;
    return html`<button
      type="button"
      class="atlas-flow-gauge atlas-instrument-readout"
      style="--flow-color:${incoming ? "#e8a28f" : "#a5cbd1"}"
      aria-label=${`${incoming ? "Defense" : "Attack"}: ${count} fronts, ${renderTroops(troops)} troops`}
      aria-expanded=${expanded}
      @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
      @click=${(event: Event) => {
        event.stopPropagation();
        this.goldExpanded = false;
        if (incoming) {
          this.incomingExpanded = !expanded;
          this.outgoingExpanded = false;
        } else {
          this.outgoingExpanded = !expanded;
          this.incomingExpanded = false;
        }
      }}
    >
      <img
        src=${incoming ? defensePostIcon : swordIcon}
        width="16"
        height="16"
        alt=""
      />
      <strong>${renderTroops(troops)}</strong>
      ${this.renderIndicators(incoming ? "defense" : "attack")}
    </button>`;
  }

  private renderIndicators(kind: "gold" | "defense" | "attack") {
    const icons: { icon?: string; label: string; urgent?: boolean }[] = [];
    if (kind === "attack") {
      if (this.outgoingAttacks.length + this.outgoingLandAttacks.length)
        icons.push({ icon: soldierIcon, label: "Outgoing fronts" });
      if (this.outgoingBoats.length)
        icons.push({ label: "Travelling transports" });
    } else if (kind === "gold") {
      if (this.tickerTypes.includes(MessageType.DONATION_RECEIVED))
        icons.push({ icon: goldCoinIcon, label: "Donation received" });
    } else {
      if (this.incomingAttacks.length)
        icons.push({
          icon: soldierIcon,
          label: "Incoming fronts",
          urgent: true,
        });
      if (this.incomingBoats.length)
        icons.push({ label: "Incoming transports", urgent: true });
      const types = new Set(
        this.tickerTypes.filter(
          (type) => type !== MessageType.DONATION_RECEIVED,
        ),
      );
      for (const [type, icon, label] of [
        [MessageType.NUKE_INBOUND, atomBombIcon, "Incoming atom bomb"],
        [
          MessageType.HYDROGEN_BOMB_INBOUND,
          hydrogenBombIcon,
          "Incoming hydrogen bomb",
        ],
        [MessageType.MIRV_INBOUND, mirvIcon, "Incoming MIRV"],
      ] as const) {
        if (types.delete(type)) icons.push({ icon, label, urgent: true });
      }
      if (types.delete(MessageType.ALLIANCE_REQUEST))
        icons.push({ icon: allianceIcon, label: "Alliance request" });
      if (types.delete(MessageType.RENEW_ALLIANCE))
        icons.push({
          icon: allianceIcon,
          label: "Expiring alliance",
          urgent: true,
        });
      if (types.delete(MessageType.CHAT))
        icons.push({
          icon: assetUrl("images/ChatIconWhite.svg"),
          label: "Chat message",
        });
      if (types.delete(MessageType.UNIT_DESTROYED))
        icons.push({
          icon: assetUrl("images/EmbargoWhiteIcon.svg"),
          label: "Unit lost / trade interrupted",
        });
      types.delete(MessageType.NAVAL_INVASION_INBOUND);
      if (types.size) icons.push({ label: "Other event notices" });
    }
    return html`<span class="atlas-ticker-indicators"
      >${icons.map((item) =>
        item.icon
          ? html`<img
              src=${item.icon}
              class=${item.urgent ? "is-urgent" : ""}
              title=${item.label}
              alt=${item.label}
            />`
          : html`<span
              class="atlas-ticker-dot ${item.urgent ? "is-urgent" : ""}"
              role="img"
              aria-label=${item.label}
              title=${item.label}
            ></span>`,
      )}</span
    >`;
  }

  render() {
    if (!this.active || !this._isVisible) {
      return html``;
    }

    const outgoing = [...this.outgoingAttacks, ...this.outgoingLandAttacks];
    const outgoingTroops =
      outgoing.reduce((sum, attack) => sum + attack.troops, 0) +
      this.outgoingBoats.reduce((sum, boat) => sum + boat.troops(), 0);
    const incomingTroops =
      this.incomingAttacks.reduce((sum, attack) => sum + attack.troops, 0) +
      this.incomingBoats.reduce((sum, boat) => sum + boat.troops(), 0);
    const player = this.game.myPlayer();
    return html` <style>
        body.atlas-theme.in-game .atlas-flow-cluster .atlas-flow-gauge {
          color: var(--flow-color) !important;
        }
        .atlas-flow-gauge > img {
          filter: brightness(0) invert(1);
          opacity: 0.9;
        }
        .atlas-flow-gauge > strong {
          color: var(--flow-color) !important;
        }
        .atlas-instrument-readout {
          position: relative;
        }
        .atlas-ticker-indicators {
          position: absolute;
          bottom: 2px;
          left: 0;
          right: 0;
          display: flex;
          justify-content: center;
          gap: 3px;
          pointer-events: none;
        }
        .atlas-ticker-indicators img {
          width: 7px;
          height: 7px;
          object-fit: contain;
          filter: brightness(0) invert(1);
        }
        .atlas-ticker-dot {
          display: block;
          width: 5px;
          height: 5px;
          margin: 1px;
          border-radius: 50%;
          background: currentColor;
        }
        .atlas-ticker-indicators .is-urgent {
          animation: atlas-ticker-pulse 1.5s ease-in-out infinite;
        }
        @keyframes atlas-ticker-pulse {
          50% {
            opacity: 0.3;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .atlas-ticker-indicators .is-urgent {
            animation: none;
          }
        }
        .atlas-flow-cluster {
          position: relative;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          margin: 4px 0;
          pointer-events: auto;
        }
        .atlas-flow-gauge {
          cursor: pointer;
          color: var(--flow-color);
        }
        .atlas-flow-gauge:focus-visible {
          outline: 2px solid #e1c787;
          outline-offset: 2px;
        }
        .atlas-flow-gauge[aria-expanded="true"] {
          box-shadow: inset 0 2px 5px #0009;
          border-color: var(--flow-color);
        }
        .atlas-flow-gauge__face {
          position: relative;
          display: block;
          flex: 0 0 38px;
          height: 38px;
          border: 2px solid #8d9385;
          border-radius: 50%;
          overflow: hidden;
          background:
            radial-gradient(circle, #142420 52%, transparent 54%),
            repeating-conic-gradient(
              from -110deg,
              #ced1b6 0deg 2deg,
              #1b2a24 2deg 22deg
            );
          box-shadow:
            inset 0 2px 4px #000,
            0 1px 1px #000;
        }
        .atlas-flow-gauge__needle {
          position: absolute;
          left: calc(50% - 1px);
          bottom: 50%;
          width: 2px;
          height: 14px;
          background: var(--flow-color);
          transform-origin: 50% 100%;
          transform: rotate(var(--flow-angle));
          transition: transform 240ms ease-out;
        }
        .atlas-flow-gauge__hub {
          position: absolute;
          left: calc(50% - 3px);
          top: calc(50% - 3px);
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #b7b9a5;
          box-shadow: 0 1px 2px #000;
        }
        .atlas-flow-gauge__readout {
          display: grid;
          text-align: left;
          min-width: 0;
          font-variant-numeric: tabular-nums;
          line-height: 1.2;
        }
        .atlas-flow-gauge__readout small {
          font-size: 10px;
          color: #c2cbbb;
        }
        .atlas-flow-gauge__readout strong {
          font-size: 14px;
          font-weight: 600;
          color: var(--flow-color);
        }
        .atlas-flow-details {
          position: absolute;
          bottom: calc(100% + 6px);
          left: 0;
          right: 0;
          z-index: 10;
          display: grid;
          gap: 4px;
          max-height: min(28vh, 180px);
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 6px;
          border: 1px solid #889585;
          border-radius: 8px;
          background: #14211ff5;
          color: #eee8d7;
          box-shadow: 0 4px 14px #0008;
        }
        .atlas-flow-details.atlas-defense-details {
          border: 0;
          box-shadow: none;
          padding: 0;
          gap: 6px;
          background: transparent;
        }
        .atlas-defense-details .fleet-control-region {
          margin: 0;
          box-shadow: none;
        }
        .atlas-defense-fronts {
          min-width: 0;
          display: grid;
          gap: 4px;
        }
        .atlas-defense-details .atlas-defense-fronts {
          padding: 6px 8px;
          border: 1px solid var(--atlas-line, #65726866);
          border-radius: 8px;
          background: var(--atlas-surface, #09151066);
        }
        .atlas-defense-fronts .atlas-auto-defend {
          border: 0;
          box-shadow: none;
          background: transparent;
          padding: 4px 0;
          text-align: left;
          min-height: 36px;
        }
        @media (prefers-reduced-motion: reduce) {
          .atlas-flow-gauge__needle {
            transition: none;
          }
        }
        .atlas-flow-cluster {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        body.atlas-theme.in-game
          .atlas-flow-cluster
          > .atlas-instrument-readout {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          min-width: 0;
          min-height: 36px;
          padding: 4px 6px;
          font-size: 14px;
          font-variant-numeric: tabular-nums;
        }
      </style>
      <div
        class="atlas-flow-cluster"
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") {
            this.goldExpanded = false;
            this.incomingExpanded = false;
            this.outgoingExpanded = false;
            event.stopPropagation();
          }
        }}
      >
        <button
          type="button"
          class="atlas-instrument-readout atlas-instrument-readout--gold"
          aria-label="Gold"
          aria-expanded=${this.goldExpanded}
          @click=${() => {
            this.goldExpanded = !this.goldExpanded;
            this.incomingExpanded = false;
            this.outgoingExpanded = false;
          }}
        >
          <img src=${goldCoinIcon} width="16" height="16" alt="" /><strong
            >${renderNumber(player?.gold() ?? 0n)}</strong
          >${this.renderIndicators("gold")}
        </button>
        ${this.renderAttackGauge("incoming", incomingTroops, this.incomingAttacks.length + this.incomingBoats.length)}
        ${this.renderAttackGauge("outgoing", outgoingTroops, outgoing.length + this.outgoingBoats.length)}
        ${
          this.goldExpanded || this.incomingExpanded || this.outgoingExpanded
            ? html`<div
                class="atlas-flow-details ${this.incomingExpanded ? "atlas-defense-details" : ""}"
                role="region"
                aria-label=${this.goldExpanded ? "Gold events" : this.incomingExpanded ? "Defense fronts" : "Attack fronts"}
              >
                ${
                  this.incomingExpanded &&
                  this.game.config().gameConfig().fleetAutomation === "v26.3"
                    ? html`<fleet-target-slider
                        .game=${this.game}
                        .eventBus=${this.eventBus}
                        .tick=${this.game.ticks()}
                        .actualCount=${player?.units(UnitType.Warship).length ?? 0}
                      ></fleet-target-slider>`
                    : ""
                }
                <section
                  class="atlas-defense-fronts"
                  aria-label=${this.incomingExpanded ? "ongoing fronts" : "activity"}
                >
                  <strong style="font-size:12px"
                    >${this.goldExpanded ? "gold · donations" : this.incomingExpanded ? "ongoing fronts" : "attack · ongoing fronts"}</strong
                  >
                  ${
                    this.incomingExpanded && player?.pressure
                      ? html`<div style="display:grid;gap:2px">
                          <button
                            type="button"
                            class="atlas-auto-defend"
                            style="min-height:36px"
                            aria-label="Auto-defend while active"
                            aria-pressed=${player.pressure.autoDefenceEnabled === true}
                            @click=${() => this.eventBus.emit(new SendMobilisationIntentEvent(player.pressure!.target, player.pressure!.autoDefenceEnabled !== true))}
                          >
                            Auto-defend while active ·
                            ${player.pressure.autoDefenceEnabled === true ? "On" : "Off"}
                          </button>
                          <small
                            >Always on while AFK. Mobilisation follows game
                            speed.</small
                          >
                        </div>`
                      : ""
                  }
                  ${this.goldExpanded ? html`<span>${renderNumber(player?.gold() ?? 0n)} gold${this.tickerTypes.includes(MessageType.DONATION_RECEIVED) ? "" : " · No new donations"}</span>` : this.incomingExpanded ? html`${this.renderIncomingAttacks()}${this.renderIncomingBoats()}${incomingTroops === 0 ? "No incoming attacks" : ""}` : html`${this.renderOutgoingAttacks()}${this.renderOutgoingLandAttacks()}${this.renderBoats()}${outgoingTroops === 0 ? "No outgoing attacks" : ""}`}
                </section>
              </div>`
            : ""
        }
      </div>`;
  }
}
