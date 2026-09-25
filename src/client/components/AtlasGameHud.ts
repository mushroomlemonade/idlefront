import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./ProductWordmark";
import "./SimulationRecoveryOverlay";

/**
 * Reusable mount deck for the canonical OpenFront HUD controllers. It composes
 * their hosts but owns no simulation, map, camera, sampling, or input logic.
 */
@customElement("atlas-game-hud")
export class AtlasGameHud extends LitElement {
  @state() private clockText = "00:00";
  @state() private showClockLogo = false;
  private readonly onClock = (event: Event) => {
    this.clockText = (event as CustomEvent<string>).detail;
  };
  private topSurfaceObserver?: ResizeObserver;
  protected firstUpdated() {
    const surface = this.querySelector(".atlas-top-command-surface");
    if (!surface || typeof ResizeObserver === "undefined") return;
    this.topSurfaceObserver = new ResizeObserver(() => {
      const rect = surface.getBoundingClientRect();
      document.documentElement.style.setProperty(
        "--atlas-top-command-bottom",
        `${rect.bottom}px`,
      );
      if (rect.width < 1 || rect.height < 1) return;
      const style = getComputedStyle(surface);
      (surface as HTMLElement).dataset.displayGeometry = JSON.stringify({
        width: rect.width,
        height: rect.height,
        top: rect.top,
        outerRadius: parseFloat(style.borderTopLeftRadius) || 11,
        mode: "safe-area-panel",
      });
    });
    this.topSurfaceObserver.observe(surface);
  }
  private readonly onPlayerInfoVisibility = (event: Event) => {
    const customEvent = event as CustomEvent<{ visible?: boolean }>;
    this.toggleAttribute(
      "data-player-info-visible",
      customEvent.detail?.visible === true,
    );
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("atlas-game-clock", this.onClock);
    this.addEventListener(
      "atlas-player-info-visibility",
      this.onPlayerInfoVisibility,
    );
  }

  disconnectedCallback(): void {
    this.removeEventListener("atlas-game-clock", this.onClock);
    this.topSurfaceObserver?.disconnect();
    document.documentElement.style.removeProperty("--atlas-top-command-bottom");
    this.removeEventListener(
      "atlas-player-info-visibility",
      this.onPlayerInfoVisibility,
    );
    super.disconnectedCallback();
  }

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <style>
        @media (max-width: 1023px) {
          atlas-game-hud .atlas-hud-notices > events-display {
            display: none !important;
          }
          atlas-game-hud .atlas-hud-notices > actionable-events {
            display: block !important;
            position: fixed;
            top: calc(var(--atlas-top-command-bottom, 100px) + 6px);
            left: 6px;
            right: 6px;
            width: auto;
            z-index: 60;
            pointer-events: none;
          }
          atlas-game-hud
            .atlas-hud-notices
            > actionable-events
            .atlas-action-notices {
            margin-top: 0;
            max-height: 32dvh;
            overflow-y: auto;
            overscroll-behavior: contain;
          }
          /* A single actionable card at a time; dismissing reveals the next. */
          atlas-game-hud
            .atlas-hud-notices
            > actionable-events
            .atlas-action-notice
            ~ .atlas-action-notice {
            display: none;
          }
          body.atlas-theme.in-game atlas-game-hud .atlas-control-deck {
            position: relative;
          }
          atlas-game-hud
            .atlas-control-deck:has(.atlas-flow-details)
            > control-panel,
          atlas-game-hud
            .atlas-control-deck:has(.atlas-flow-details)
            > unit-display {
            visibility: hidden;
          }
          atlas-game-hud .atlas-control-deck .atlas-flow-cluster {
            position: static;
          }
          atlas-game-hud .atlas-control-deck .atlas-flow-details {
            top: 50px;
            bottom: max(
              6px,
              var(--native-safe-bottom, 0px),
              env(safe-area-inset-bottom, 0px)
            );
            left: 6px;
            right: 6px;
            max-height: none;
            align-content: start;
            grid-auto-rows: max-content;
            box-shadow: none;
            scrollbar-width: none;
          }
          atlas-game-hud .atlas-flow-details::-webkit-scrollbar {
            display: none;
          }
          atlas-game-hud .atlas-flow-details > div:not(.atlas-flow-cluster) {
            min-height: 28px;
            flex-shrink: 0;
          }
          atlas-game-hud .atlas-flow-details > div > button {
            min-height: 26px;
            padding-top: 2px;
            padding-bottom: 2px;
            font-size: 12px;
          }
          atlas-game-hud .atlas-flow-details > div > small {
            font-size: 10px;
            line-height: 1.2;
          }
          atlas-game-hud .atlas-flow-details events-display,
          atlas-game-hud .atlas-flow-details actionable-events {
            display: block;
            width: 100%;
          }
          atlas-game-hud .atlas-flow-details .events-container,
          atlas-game-hud .atlas-flow-details .important-events-container {
            max-height: none;
            overflow: visible;
          }
          atlas-game-hud .atlas-flow-details table {
            font-size: 12px;
          }
        }
      </style>
      <div
        class="atlas-hud-dock fixed bottom-0 left-0 w-full z-[200] flex flex-col pointer-events-none sm:flex-row sm:items-end lg:grid lg:grid-cols-[1fr_500px_1fr] lg:items-end"
      >
        <div
          class="atlas-hud-controls contents sm:flex sm:flex-col sm:pointer-events-none w-full sm:w-[500px] lg:col-start-2 sm:z-10"
        >
          <div
            class="atlas-control-deck pointer-events-auto order-3 sm:order-none"
          >
            <attacks-display
              class="block w-full pointer-events-auto px-2"
            ></attacks-display>
            <control-panel class="w-full"></control-panel>
            <unit-display class="hidden lg:block w-full"></unit-display>
          </div>
        </div>

        <div
          class="atlas-hud-notices flex flex-col pointer-events-none items-end order-2 sm:order-none sm:flex-1 lg:col-start-3 lg:self-end lg:justify-end"
        >
          <chat-display
            class="w-full sm:w-auto pointer-events-auto"
          ></chat-display>
          <events-display
            class="w-full sm:w-auto pointer-events-auto"
          ></events-display>
          <actionable-events
            class="w-full sm:w-auto pointer-events-auto"
          ></actionable-events>
        </div>
      </div>

      <emoji-table></emoji-table>
      <build-menu></build-menu>
      <win-modal></win-modal>
      <new-lobby-prompt></new-lobby-prompt>
      <game-starting-modal></game-starting-modal>
      <simulation-recovery-overlay></simulation-recovery-overlay>
      <div class="atlas-top-command-surface">
        <button
          type="button"
          data-game-timer
          class="atlas-nav-clock"
          aria-label=${this.showClockLogo ? "Show game time" : `Game time ${this.clockText}. Show Idlefront logo`}
          @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
          @click=${(event: Event) => {
            event.stopPropagation();
            this.showClockLogo = !this.showClockLogo;
          }}
        >
          ${this.showClockLogo ? html`<span class="atlas-clock-swap"><product-wordmark compact quiet></product-wordmark></span>` : html`<span class="atlas-clock-swap">${this.clockText}</span>`}
        </button>
        <game-left-sidebar></game-left-sidebar>
        <div
          class="atlas-hud-corner-stack atlas-hud-top-actions flex flex-col items-end fixed top-0 right-0 min-[1200px]:top-4 min-[1200px]:right-4 z-1000 gap-2"
        >
          <game-right-sidebar></game-right-sidebar>
          <replay-panel></replay-panel>
        </div>
        <player-info-overlay></player-info-overlay>
      </div>
      <settings-modal></settings-modal>
      <graphics-settings-modal></graphics-settings-modal>
      <player-panel></player-panel>
      <spawn-timer></spawn-timer>
      <immunity-timer></immunity-timer>
      <in-game-promo class="hidden"></in-game-promo>
      <alert-frame></alert-frame>
      <chat-modal></chat-modal>
      <multi-tab-modal></multi-tab-modal>
      <performance-overlay></performance-overlay>
      <heads-up-message></heads-up-message>
    `;
  }
}
