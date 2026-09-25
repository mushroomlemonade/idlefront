import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { EventBus } from "../../core/EventBus";
import { GoToPlayerEvent } from "../TransformHandler";
import type { GameView } from "../view";
import "./IdleDashboard";

/** Camera actions only; fleet controls live in the defense slider. */
@customElement("fleet-panel")
export class FleetPanel extends LitElement {
  @property({ attribute: false }) game: GameView;
  @property({ attribute: false }) eventBus: EventBus;
  @property({ type: Number }) tick = 0;
  @state() private idle = false;
  private lastInput = Date.now();
  private inactivityTimer?: ReturnType<typeof setInterval>;
  private recordInput = () => {
    this.lastInput = Date.now();
  };
  connectedCallback() {
    super.connectedCallback();
    for (const name of ["pointerdown", "pointermove", "keydown", "wheel"])
      document.addEventListener(name, this.recordInput, {
        capture: true,
        passive: true,
      });
    this.inactivityTimer = setInterval(() => {
      if (
        !this.idle &&
        !document.hidden &&
        this.getClientRects().length &&
        this.game?.myPlayer()?.isAlive() &&
        this.game.myPlayer()?.pressure &&
        Date.now() - this.lastInput >= 120000
      )
        this.idle = true;
    }, 1000);
  }
  disconnectedCallback() {
    clearInterval(this.inactivityTimer);
    for (const name of ["pointerdown", "pointermove", "keydown", "wheel"])
      document.removeEventListener(name, this.recordInput, true);
    super.disconnectedCallback();
  }
  createRenderRoot() {
    return this;
  }
  render() {
    const player = this.game?.myPlayer();
    if (!player?.isAlive()) return nothing;
    return html`
      <style>
        fleet-panel {
          display: block;
        }
        .fleet-actions {
          display: flex;
          gap: 8px;
          justify-content: stretch;
          margin: 0;
        }
        .fleet-actions button {
          min-height: 44px;
          padding: 2px 12px;
          flex: 1;
        }
      </style>
      ${
        player.pressure
          ? html`<div class="fleet-actions">
              <button
                @click=${() => this.eventBus.emit(new GoToPlayerEvent(player))}
              >
                focus
              </button>
              <button
                @click=${() => {
                  this.idle = true;
                }}
              >
                idle
              </button>
            </div>`
          : nothing
      }
      ${
        this.idle
          ? html`<idle-dashboard
              .game=${this.game}
              .eventBus=${this.eventBus}
              @idle-resume=${() => {
                this.idle = false;
                this.recordInput();
              }}
            ></idle-dashboard>`
          : nothing
      }
    `;
  }
}
