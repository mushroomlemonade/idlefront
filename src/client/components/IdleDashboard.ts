import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { EventBus } from "../../core/EventBus";
import { UnitType } from "../../core/game/Game";
import {
  CinematicFollowEvent,
  GoToPlayerEvent,
  GoToPositionEvent,
  IdleCameraEvent,
} from "../TransformHandler";
import { GameSessionEndedEvent, SendIdleModeEvent } from "../Transport";
import { renderNumber } from "../Utils";
import type { GameView, UnitView } from "../view";
import { cinematicInterest } from "./CinematicInterest";

@customElement("idle-dashboard")
export class IdleDashboard extends LitElement {
  @property({ attribute: false }) game: GameView;
  @property({ attribute: false }) eventBus: EventBus;
  @state() private motion = !window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  @state() private netGold = 0;
  @state() private sampled = false;
  @state() private leaders: {
    id: number;
    name: string;
    land: number;
    samples: number[];
  }[] = [];
  @state() private rank = 0;
  @state() private deliveryGold = 0;
  private deliveryUntil = 0;
  private lastDeliveryId = 0;
  private timer?: ReturnType<typeof setInterval>;
  private subject?: UnitView;
  private shotUntil = 0;
  private holdUntil = 0;
  private mirvGroup: UnitView[] = [];
  private mirvUntil = 0;
  private localFocus?: { x: number; y: number };
  private refreshes = 0;
  private lastSample?: { tick: number; gold: bigint };
  private active = false;
  private taps: number[] = [];
  private pointerStart?: { x: number; y: number; time: number };
  private tapStart = (event: PointerEvent) => {
    event.stopPropagation();
    this.pointerStart = {
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
    };
  };
  private tapEnd = (event: PointerEvent) => {
    event.stopPropagation();
    const start = this.pointerStart;
    this.pointerStart = undefined;
    if (
      !start ||
      performance.now() - start.time > 400 ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 20
    )
      return;
    const now = performance.now();
    this.taps = [...this.taps.filter((t) => now - t < 900), now];
    if (this.taps.length >= 3) {
      // Keep the modal until the synthetic click has been consumed.
      event.preventDefault();
      setTimeout(this.resume, 0);
    }
  };
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private onReducedMotion = () => {
    if (this.reducedMotion.matches) {
      this.motion = false;
      if (this.active) {
        this.eventBus.emit(new IdleCameraEvent(false));
        this.eventBus.emit(new IdleCameraEvent(true));
      }
    }
  };
  createRenderRoot() {
    return this;
  }
  firstUpdated() {
    this.active = true;
    this.eventBus.on(GameSessionEndedEvent, this.resume);
    this.eventBus.emit(new SendIdleModeEvent(true));
    this.eventBus.emit(new IdleCameraEvent(true));
    document.body.classList.add("idlefront-dashboard-active");
    const dialog = this.querySelector("dialog");
    dialog?.showModal();
    // Native dialog autofocus would otherwise highlight the resume button on iOS.
    // Space is handled independently; keep Tab navigation to controls available.
    dialog?.focus({ preventScroll: true });
    document.addEventListener("keydown", this.blockKeys, true);
    this.reducedMotion.addEventListener("change", this.onReducedMotion);
    this.refresh();
    if (this.active) this.timer = setInterval(() => this.refresh(), 500);
  }
  private blockKeys = (event: KeyboardEvent) => {
    // Allow native focus/activation inside this dialog, never game hotkeys.
    if (event.key === "Escape" || event.code === "Space" || event.key === " ") {
      event.preventDefault();
      this.resume();
    }
    const isControl =
      event.target instanceof Element &&
      this.contains(event.target) &&
      event.target.closest("button,input,select");
    if (
      event.key !== "Tab" &&
      !(isControl && ["Enter", " "].includes(event.key))
    ) {
      event.preventDefault();
    }
    // Keep native focus and button activation, but do not forward even Tab or
    // Space to window-level game shortcuts.
    event.stopImmediatePropagation();
  };
  private resume = () => {
    if (!this.active) return;
    this.cleanup();
    this.dispatchEvent(new CustomEvent("idle-resume", { bubbles: true }));
  };
  private cleanup() {
    if (!this.active) return;
    this.active = false;
    this.eventBus.off(GameSessionEndedEvent, this.resume);
    clearInterval(this.timer);
    this.timer = undefined;
    this.subject = undefined;
    this.mirvGroup = [];
    this.querySelector("dialog")?.close();
    document.removeEventListener("keydown", this.blockKeys, true);
    this.reducedMotion.removeEventListener("change", this.onReducedMotion);
    document.body.classList.remove("idlefront-dashboard-active");
    this.eventBus.emit(new IdleCameraEvent(false));
    this.eventBus.emit(new SendIdleModeEvent(false));
  }
  disconnectedCallback() {
    this.cleanup();
    super.disconnectedCallback();
  }
  private refresh() {
    const player = this.game.myPlayer();
    if (!player?.isAlive()) {
      this.resume();
      return;
    }
    if (this.refreshes % 10 === 0) {
      const tick = this.game.ticks(),
        gold = player.gold();
      if (this.lastSample && tick > this.lastSample.tick) {
        this.netGold =
          (Number(gold - this.lastSample.gold) * 10) /
          (tick - this.lastSample.tick);
        this.sampled = true;
      }
      this.lastSample = { tick, gold };
      // Visible roster only; native fog projection controls what is available.
      const ranked = this.game
        .players()
        .filter((p) => p.isAlive())
        .sort(
          (a, b) =>
            b.numTilesOwned() - a.numTilesOwned() || a.smallID() - b.smallID(),
        );
      this.rank = ranked.findIndex((p) => p.id() === player.id()) + 1;
      this.leaders = ranked.slice(0, 3).map((p) => ({
        id: p.smallID(),
        name: p.name(),
        land: p.numTilesOwned(),
        samples: [
          ...(this.leaders.find((l) => l.id === p.smallID())?.samples ?? []),
          p.numTilesOwned(),
        ].slice(-36),
      }));
    }
    if (this.motion && !document.hidden) {
      const now = performance.now();
      if (now >= this.deliveryUntil) this.deliveryGold = 0;
      const origin = this.localFocus ?? player.nameLocation?.();
      const nearby = (u: UnitView) =>
        !origin ||
        Math.hypot(
          this.game.x(u.tile()) - origin.x,
          this.game.y(u.tile()) - origin.y,
        ) <= 96;
      const isNuke = (u: UnitView) =>
        [
          UnitType.AtomBomb,
          UnitType.HydrogenBomb,
          UnitType.MIRV,
          UnitType.MIRVWarhead,
        ].includes(u.type());
      const missiles = this.game.cinematicNukes?.() ?? [];
      if (this.subject && isNuke(this.subject) && !this.subject.isActive()) {
        const previous = this.subject;
        this.subject = undefined;
        const tile = previous.reachedTarget()
          ? (previous.targetTile?.() ?? previous.tile())
          : previous.tile();
        this.localFocus = { x: this.game.x(tile), y: this.game.y(tile) };
        if (this.game.isTileVisible(tile)) {
          const branches =
            previous.type() === UnitType.MIRV
              ? missiles.filter(
                  (u) =>
                    u.type() === UnitType.MIRVWarhead &&
                    u.state.ownerID === previous.state.ownerID &&
                    Math.hypot(
                      this.game.x(u.tile()) - this.game.x(tile),
                      this.game.y(u.tile()) - this.game.y(tile),
                    ) < 160,
                )
              : [];
          if (branches.length) {
            this.mirvGroup = branches;
            this.mirvUntil = now + 30000;
          } else if (previous.reachedTarget()) {
            // Interception/despawn is not an impact; only a confirmed landing earns an aftermath shot.
            this.holdUntil = now + 8000;
            const radius =
              this.game.config?.().nukeMagnitudes(previous.type()).outer ?? 30;
            this.eventBus.emit(
              new GoToPositionEvent(
                this.game.x(tile),
                this.game.y(tile),
                Math.min(
                  1.8,
                  (window.innerWidth * 0.22) / (radius * 2),
                  (window.innerHeight * 0.22) / (radius * 2),
                ),
                true,
              ),
            );
          }
        }
      }
      if (this.mirvGroup.length && now < this.mirvUntil) {
        const visible = this.mirvGroup.filter((u) =>
          this.game.isTileVisible(u.tile()),
        );
        if (visible.length) {
          const xs = visible.map((u) => this.game.x(u.tile()));
          const ys = visible.map((u) => this.game.y(u.tile()));
          const left = Math.min(...xs) - 24,
            right = Math.max(...xs) + 24;
          const top = Math.min(...ys) - 24,
            bottom = Math.max(...ys) + 24;
          const x = (left + right) / 2,
            y = (top + bottom) / 2;
          this.localFocus = { x, y };
          this.eventBus.emit(
            new GoToPositionEvent(
              x,
              y,
              Math.min(
                2.4,
                (window.innerWidth * 0.22) / (right - left),
                (window.innerHeight * 0.22) / (bottom - top),
              ),
              true,
              0.35,
            ),
          );
          if (!visible.some((u) => u.isActive())) {
            this.mirvGroup = [];
            this.holdUntil = now + 8000;
          }
          this.refreshes++;
          this.requestUpdate();
          return;
        }
      }
      this.mirvGroup = [];
      if (now < this.holdUntil) {
        this.refreshes++;
        this.requestUpdate();
        return;
      }
      if (
        this.subject?.isActive() &&
        this.game.unit &&
        this.game.unit(this.subject.id()) !== this.subject
      )
        this.subject = undefined;
      const types = [
        UnitType.Warship,
        UnitType.Train,
        UnitType.TradeShip,
        UnitType.TransportShip,
      ];
      const candidates = [
        ...missiles,
        ...types.flatMap((type) => player.units(type).slice(0, 64)),
      ];
      if (
        origin &&
        this.game.nearbyUnits &&
        this.game.isValidCoord(Math.floor(origin.x), Math.floor(origin.y))
      ) {
        candidates.push(
          ...this.game
            .nearbyUnits(
              this.game.ref(Math.floor(origin.x), Math.floor(origin.y)),
              96,
              types,
            )
            .slice(0, 256)
            .map((entry) => entry.unit),
        );
      }
      const routeLength = (u: UnitView) => {
        if (
          u.type() === UnitType.Train &&
          this.game.cinematicTrainRouteLength
        ) {
          return this.game.cinematicTrainRouteLength(u.id());
        }
        const target = u.targetTile?.();
        return target === undefined
          ? 0
          : Math.hypot(
              this.game.x(target) - this.game.x(u.tile()),
              this.game.y(target) - this.game.y(u.tile()),
            );
      };
      const ranked = [...new Set(candidates)]
        .filter(
          (u) => u.isActive() && this.game.isTileVisible(u.tile()) && nearby(u),
        )
        .sort(
          (a, b) =>
            cinematicInterest(b) - cinematicInterest(a) ||
            (a.type() === UnitType.Train ? routeLength(b) - routeLength(a) : 0),
        );
      const currentScore = this.subject?.isActive()
        ? cinematicInterest(this.subject)
        : -1;
      const best = ranked[0];
      const delivery = [...(this.game.cinematicDeliveries ?? [])]
        .reverse()
        .find(
          (event) =>
            event.id > this.lastDeliveryId &&
            this.game.ticks() - event.tick <= 30 &&
            origin &&
            this.game.isTileVisible(event.tile) &&
            Math.hypot(
              this.game.x(event.tile) - origin.x,
              this.game.y(event.tile) - origin.y,
            ) < 32,
        );
      if (delivery) {
        this.lastDeliveryId = delivery.id;
        this.deliveryGold = delivery.gold;
        this.deliveryUntil = now + 5000;
        if (
          (!best || cinematicInterest(best) <= 200) &&
          this.subject &&
          [UnitType.Train, UnitType.TradeShip].includes(this.subject.type())
        ) {
          this.subject = undefined;
          this.localFocus = {
            x: this.game.x(delivery.tile),
            y: this.game.y(delivery.tile),
          };
          this.holdUntil = now + 3000;
          this.eventBus.emit(
            new GoToPositionEvent(this.localFocus.x, this.localFocus.y, 5.6),
          );
          this.refreshes++;
          this.requestUpdate();
          return;
        }
      }
      if (
        best &&
        (cinematicInterest(best) > currentScore ||
          !this.subject?.isActive() ||
          (now >= this.shotUntil && !isNuke(this.subject)))
      ) {
        this.subject = best;
        this.shotUntil = now + 30000;
      }
      const tile = this.subject?.tile();
      if (
        tile !== undefined &&
        this.subject?.isActive() &&
        this.game.isTileVisible(tile)
      ) {
        this.localFocus = { x: this.game.x(tile), y: this.game.y(tile) };
        this.eventBus.emit(
          new CinematicFollowEvent(
            this.subject!,
            isNuke(this.subject!) ? 4.8 : 5.6,
          ),
        );
      } else {
        this.subject = undefined;
        const name = player.nameLocation?.();
        if (
          name &&
          (!this.localFocus ||
            Math.hypot(
              name.x - this.localFocus.x,
              name.y - this.localFocus.y,
            ) <= 96) &&
          this.game.isValidCoord(name.x, name.y) &&
          this.game.isTileVisible(this.game.ref(name.x, name.y))
        ) {
          this.localFocus = { x: name.x, y: name.y };
          this.eventBus.emit(new GoToPlayerEvent(player));
        }
      }
    }
    this.refreshes++;
    this.requestUpdate();
  }
  render() {
    const player = this.game?.myPlayer();
    if (!player) return nothing;
    const ships = player.units(UnitType.Warship);
    const combat = ships.filter((s) => s.warshipState()?.isInCombat).length;
    const attacks = player
      .outgoingAttacks()
      .reduce((sum, a) => sum + a.troops, 0);
    const defense = player
      .incomingAttacks()
      .reduce((sum, a) => sum + a.troops, 0);
    return html`<style>
        .idlefront-dashboard-active atlas-game-hud {
          visibility: hidden;
        }
        .idlefront-dashboard-active #webgl-debug-canvas {
          transform: perspective(max(700px, 110dvh)) rotateX(39deg)
            rotateZ(-5deg) scale(3.2);
          transform-origin: center;
          animation: idle-board-orbit 40s ease-in-out infinite alternate;
          will-change: transform;
        }
        @keyframes idle-board-orbit {
          from {
            transform: perspective(max(700px, 110dvh)) rotateX(36deg)
              rotateZ(-5deg) scale(3.2);
          }
          to {
            transform: perspective(max(700px, 110dvh)) rotateX(42deg)
              rotateZ(4deg) scale(3.3);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .idlefront-dashboard-active #webgl-debug-canvas {
            transform: none;
            animation: none;
          }
        }
        idle-dashboard,
        idle-dashboard * {
          visibility: visible;
        }
        .idle-dashboard-dialog {
          outline: none;
          border: 0;
          background: transparent;
          color: #eee9d4;
          max-width: none;
          max-height: none;
          width: 100%;
          height: 100dvh;
          padding: 0;
          margin: 0;
          overscroll-behavior: contain;
          touch-action: none;
        }
        .idle-dashboard-dialog::backdrop {
          background: transparent;
        }
        .idle-dashboard-readouts {
          position: absolute;
          left: 10px;
          right: 10px;
          bottom: max(10px, env(safe-area-inset-bottom));
          max-height: 48dvh;
          overflow: auto;
          touch-action: pan-y;
          overscroll-behavior: contain;
          padding: 12px;
          border: 0;
          background: transparent;
          text-shadow:
            0 1px 4px #000,
            0 0 10px #000;
          font-variant-numeric: tabular-nums;
        }
        .idle-dashboard-readouts header {
          display: flex;
          gap: 12px;
          align-items: center;
          justify-content: space-between;
          position: sticky;
          top: -12px;
          background: transparent;
          padding: 6px 0;
        }
        .idle-dashboard-readouts button {
          min-height: 44px;
          padding: 8px 16px;
          background: #101b1680;
          color: inherit;
          border: 1px solid #8f927b;
          border-radius: 10px;
        }
        .idle-dashboard-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          margin: 10px 0;
        }
        .idle-dashboard-grid span {
          font-size: 12px;
          display: block;
          opacity: 0.8;
        }
        .idle-dashboard-grid strong {
          font-size: 17px;
        }
        .idle-leader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          font-size: 12px;
        }
        .idle-leader svg {
          width: 90px;
          height: 20px;
          flex-shrink: 0;
        }
        @media (min-width: 769px) {
          .idle-dashboard-readouts {
            left: auto;
            right: 20px;
            width: 400px;
          }
        }
      </style>
      <dialog
        class="idle-dashboard-dialog"
        tabindex="-1"
        aria-label="idle nation dashboard"
        @cancel=${(e: Event) => {
          e.preventDefault();
          this.resume();
        }}
        @pointerdown=${this.tapStart}
        @pointerup=${this.tapEnd}
        @pointercancel=${() => {
          this.pointerStart = undefined;
          this.taps = [];
        }}
        @click=${(e: Event) => e.stopPropagation()}
      >
        <section class="idle-dashboard-readouts">
          <header>
            <span>idle</span><button @click=${this.resume}>resume</button>
          </header>
          <div class="idle-dashboard-grid">
            <div>
              <span>gold</span><strong>${renderNumber(player.gold())}</strong
              ><span
                >${this.deliveryGold ? `+${renderNumber(this.deliveryGold)} gold received` : this.sampled ? `${this.netGold >= 0 ? "+" : "−"}${renderNumber(Math.abs(this.netGold))}/sec net · sampled` : "sampling net gold…"}</span
              >
            </div>
            <div>
              <span>warships</span><strong>${ships.length}</strong
              ><span
                >${combat} in combat ·
                ${ships.filter((s) => s.isUnderConstruction()).length + (player.fleet?.pending ?? 0)}
                building</span
              >
            </div>
            <div>
              <span>attack / defense</span
              ><strong
                >${renderNumber(attacks)} / ${renderNumber(defense)}</strong
              >
            </div>
            <div>
              <span>visible land rank</span
              ><strong>${this.rank ? `#${this.rank}` : "—"}</strong
              ><span>${player.fleet?.status ?? "fleet automation off"}</span>
            </div>
          </div>
          ${this.leaders.map((leader) => {
            const max = Math.max(1, ...leader.samples);
            return html`<div class="idle-leader">
              <span>${leader.name}</span
              ><svg
                viewBox="0 0 100 20"
                role="img"
                aria-label="recent territory trend"
              >
                <polyline
                  fill="none"
                  stroke="#c3b676"
                  stroke-width="1.5"
                  points=${leader.samples.map((n, i) => `${(i * 100) / 35},${19 - (n / max) * 18}`).join(" ")}
                ></polyline>
              </svg>
            </div>`;
          })}
          <label hidden
            ><input
              type="checkbox"
              .checked=${this.motion}
              @change=${(e: Event) => {
                this.motion = (e.target as HTMLInputElement).checked;
                if (!this.motion) {
                  this.eventBus.emit(new IdleCameraEvent(false));
                  this.eventBus.emit(new IdleCameraEvent(true));
                }
              }}
            />
            camera motion</label
          >
          <p style="font-size:12px">triple tap or press space to resume</p>
        </section>
      </dialog>`;
  }
}
