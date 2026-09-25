import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { EventBus } from "../../core/EventBus";
import {
  affordableFleetMaximum,
  fleetPurchaseCost,
  warshipCost,
} from "../../core/FleetAffordability";
import { FleetOrdersSchema, type FleetOrders } from "../../core/FleetOrders";
import { UnitType } from "../../core/game/Game";
import "../styles/fleet-controls.css";
import { ResolveMapPositionEvent } from "../TransformHandler";
import { SendFleetOrdersEvent } from "../Transport";
import { renderNumber } from "../Utils";
import type { GameView } from "../view";
import "./PopulationRatioSlider";

@customElement("fleet-target-slider")
export class FleetTargetSlider extends LitElement {
  @property({ attribute: false }) game: GameView;
  @property({ attribute: false }) eventBus: EventBus;
  @property({ type: Number }) tick = 0;
  @property({ type: Number }) actualCount: number | undefined;
  @state() private draft: number | null = null;
  private dragging = false;
  private pendingUntil = 0;
  @state() private nextCost: bigint | null = null;
  private quotePending = false;
  private nextQuoteAt = 0;
  private dragMaximum = 1;
  @state() private selectedOrder: FleetOrders["order"] | null = null;
  @state() private picking = false;
  @state() private pickError = "";
  private patrolTile: number | undefined;
  @state() private modePosition: number | null = null;
  private modePointer: number | null = null;
  private suppressModeClick = false;
  private moveMode = (event: PointerEvent) => {
    if (this.modePointer !== event.pointerId) return;
    event.stopPropagation();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.modePosition = Math.max(
      0,
      Math.min(2, ((event.clientX - box.left) / box.width) * 3 - 0.5),
    );
  };
  private startMode = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.modePointer = event.pointerId;
    this.suppressModeClick = false;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.moveMode(event);
  };
  private endMode = (event: PointerEvent) => {
    if (this.modePointer !== event.pointerId) return;
    this.moveMode(event);
    const index = Math.round(this.modePosition ?? 0);
    this.modePointer = null;
    this.modePosition = null;
    this.suppressModeClick = true;
    this.selectOrder((["defend", "escort", "patrol"] as const)[index]);
  };
  private cancelMode = (event: PointerEvent) => {
    event.stopPropagation();
    this.modePointer = null;
    this.modePosition = null;
  };
  private selectOrder(order: FleetOrders["order"]) {
    if (order === "patrol") {
      this.picking = true;
      this.pickError = "";
      return;
    }
    this.selectedOrder = order;
    this.draft ??= this.game.myPlayer()?.fleet?.target ?? 0;
    this.commit();
  }
  private pickPatrol = (event: MouseEvent) => {
    event.stopPropagation();
    this.eventBus.emit(
      new ResolveMapPositionEvent(event.clientX, event.clientY, (cell) => {
        if (!this.game.isValidCoord(cell.x, cell.y)) return;
        const tile = this.game.ref(cell.x, cell.y);
        if (!this.game.isWater(tile) || !this.game.isTileVisible(tile)) {
          this.pickError = "choose visible water";
          return;
        }
        this.patrolTile = tile;
        this.selectedOrder = "patrol";
        this.picking = false;
        this.draft ??= this.game.myPlayer()?.fleet?.target ?? 0;
        this.commit();
      }),
    );
  };
  private refreshQuote() {
    const player = this.game?.myPlayer();
    if (
      !player?.buildables ||
      this.quotePending ||
      Date.now() < this.nextQuoteAt
    )
      return;
    this.quotePending = true;
    this.nextQuoteAt = Date.now() + 3000;
    void player
      .buildables(undefined, [UnitType.Warship])
      .then((items) => {
        if (this.isConnected && this.game.myPlayer() === player)
          this.nextCost =
            items.find((item) => item.type === UnitType.Warship)?.cost ?? null;
      })
      .catch(() => {
        /* Retain last confirmed quote until the next refresh. */
      })
      .finally(() => {
        this.quotePending = false;
      });
  }
  createRenderRoot() {
    return this;
  }
  protected willUpdate() {
    this.refreshQuote();
    if (
      this.selectedOrder !== null &&
      !this.picking &&
      (this.game?.myPlayer()?.fleet?.order === this.selectedOrder ||
        Date.now() > this.pendingUntil)
    ) {
      this.selectedOrder = null;
      this.patrolTile = undefined;
    }
    if (
      !this.dragging &&
      this.draft !== null &&
      (this.game?.myPlayer()?.fleet?.target === this.draft ||
        Date.now() > this.pendingUntil)
    )
      this.draft = null;
  }
  private commit = () => {
    this.dragging = false;
    const player = this.game.myPlayer();
    if (!player?.isAlive() || this.draft === null) return;
    this.draft = Math.round(this.draft);
    const fleet = player.fleet;
    const result = FleetOrdersSchema.safeParse({
      enabled: true,
      automaticPorts: true,
      target: this.draft,
      reserve: fleet?.reserve ?? 100000,
      ports: [],
      order: this.selectedOrder ?? fleet?.order ?? "defend",
      ...((this.patrolTile ?? fleet?.patrolTile) === undefined
        ? {}
        : { patrolTile: this.patrolTile ?? fleet?.patrolTile }),
    });
    if (result.success) {
      this.pendingUntil = Date.now() + 5000;
      this.eventBus.emit(new SendFleetOrdersEvent(result.data));
    } else this.draft = null;
  };
  render() {
    const player = this.game?.myPlayer();
    if (!player?.isAlive()) return nothing;
    const target = this.draft ?? player.fleet?.target ?? 0;
    const owned = this.actualCount ?? player.units(UnitType.Warship).length;
    const reserve = BigInt(player.fleet?.reserve ?? 100000);
    const maximum = this.dragging
      ? this.dragMaximum
      : Math.max(
          1,
          target,
          owned,
          this.nextCost === null
            ? 1
            : affordableFleetMaximum(
                owned,
                player.gold(),
                reserve,
                this.nextCost,
              ),
        );
    const graphMax = maximum;
    // Replacement value on the native cost curve, not lifetime spending (losses/captures differ).
    const fleetValue = fleetPurchaseCost(
      owned,
      this.nextCost === 0n ? 0n : BigInt(warshipCost(0)),
    );
    return html`<div
      class="fleet-control-region"
      @pointercancel=${() => {
        this.dragging = false;
        this.draft = null;
      }}
    >
      <div class="fleet-control-heading">
        <span>auto warship fleet</span
        ><span>${renderNumber(fleetValue)} gold fleet value</span>
      </div>
      <div class="fleet-control-grid">
        <population-ratio-slider
          .snapInteger=${true}
          .value=${target}
          .max=${maximum}
          .readout=${`${renderNumber(fleetValue)} gold fleet value`}
          label="auto warship fleet"
          suffix=" warships"
          description="fixed target ship count; blue is actual ships, gold is remaining to target; fleet value is replacement cost"
          .available=${(owned / graphMax) * 100}
          .committed=${(Math.max(0, target - owned) / graphMax) * 100}
          .barValue=${`actual ${owned}`}
          .barEndValue=${`target ${Math.round(target)}`}
          @attack-ratio-input=${(e: CustomEvent<{ value: number }>) => {
            e.stopPropagation();
            if (this.nextCost === null) return;
            if (!this.dragging) {
              this.dragMaximum = maximum;
            }
            this.dragging = true;
            this.draft = e.detail.value;
          }}
          @change=${this.commit}
        ></population-ratio-slider>
        <div
          class="fleet-mode-switch ${this.modePosition === null ? "" : "is-dragging"}"
          style=${`--fleet-mode-position:${this.modePosition ?? ["defend", "escort", "patrol"].indexOf(this.selectedOrder ?? player.fleet?.order ?? "defend")}`}
          role="group"
          aria-label="warship behavior"
          @pointerdown=${this.startMode}
          @pointermove=${this.moveMode}
          @pointerup=${this.endMode}
          @pointercancel=${this.cancelMode}
          @lostpointercapture=${this.cancelMode}
        >
          ${(
            [
              ["defend", "ports", "defend home ports"],
              ["escort", "escort", "escort trade ships and transports"],
              ["patrol", "patrol", "choose patrol area"],
            ] as const
          ).map(
            ([order, label, title]) =>
              html`<button
                title=${title}
                aria-label=${title}
                aria-pressed=${String((this.selectedOrder ?? player.fleet?.order ?? "defend") === order)}
                @click=${(event: MouseEvent) => {
                  if (this.suppressModeClick && event.detail > 0) {
                    this.suppressModeClick = false;
                    return;
                  }
                  this.selectOrder(order);
                }}
              >
                ${label}
              </button>`,
          )}
        </div>
      </div>
      <small class="fleet-status"
        >${target === 0 ? "no replenishment requested" : (player.fleet?.status ?? "target met")}</small
      >
      ${
        this.picking
          ? html`<div
              role="dialog"
              aria-label="choose fleet patrol area"
              style="position:fixed;inset:0;z-index:10000;touch-action:none"
              @pointerdown=${(e: Event) => e.stopPropagation()}
              @pointerup=${(e: Event) => e.stopPropagation()}
              @click=${this.pickPatrol}
            >
              <div
                style="position:absolute;top:max(80px,env(safe-area-inset-top));left:10px;right:10px;padding:12px;background:#14251fee;border:1px solid #8f845e;border-radius:12px"
                @click=${(e: Event) => e.stopPropagation()}
              >
                ${this.pickError || "tap visible water for patrol"}
                <button
                  @click=${() => {
                    this.picking = false;
                  }}
                >
                  cancel
                </button>
              </div>
            </div>`
          : nothing
      }
    </div>`;
  }
}
