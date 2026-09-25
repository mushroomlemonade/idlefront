import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { GameMode, GameType, RankedType } from "../../../core/game/Game";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import { Controller } from "../../Controller";
import { translateText } from "../../Utils";
import { GameView } from "../../view";

const COLLUSION_WARNING_CLOSED_KEY = "hasClosedCollusionWarning";

@customElement("heads-up-message")
export class HeadsUpMessage extends LitElement implements Controller {
  public game: GameView;

  @state()
  private isVisible = false;

  @state()
  private hasClosedCollusionWarning =
    localStorage.getItem(COLLUSION_WARNING_CLOSED_KEY) !== null;

  @state()
  private isPaused = false;

  @state()
  private isImmunityActive = false;

  @state()
  private isCatchingUp = false;
  @state()
  private fastForwardRequested = false;
  private catchingUpTicks = 0;
  @state()
  private graceSeconds = 0;

  private static readonly CATCHING_UP_SHOW_THRESHOLD = 10;

  @state()
  private toastMessage: string | import("lit").TemplateResult | null = null;
  @state()
  private toastColor: "green" | "red" = "green";
  private toastTimeout: number | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(
      "show-message",
      this.handleShowMessage as EventListener,
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(
      "show-message",
      this.handleShowMessage as EventListener,
    );
    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
    }
  }

  private handleShowMessage = (event: CustomEvent) => {
    const { message, duration, color } = event.detail ?? {};
    if (
      typeof message === "string" ||
      (message && typeof message.values === "object")
    ) {
      this.toastMessage = message;
      this.toastColor = color === "red" ? "red" : "green";
      this.requestUpdate();
      if (this.toastTimeout) {
        clearTimeout(this.toastTimeout);
      }
      this.toastTimeout = window.setTimeout(
        () => {
          this.toastMessage = null;
          this.requestUpdate();
        },
        typeof duration === "number" ? (duration ?? 2000) : 2000,
      );
    }
  };

  init() {
    this.isVisible = true;
    this.requestUpdate();
  }

  tick() {
    const updates = this.game.updatesSinceLastTick();
    const pauseUpdates = updates?.[GameUpdateType.GamePaused];
    if (pauseUpdates && pauseUpdates.length > 0) {
      this.isPaused = pauseUpdates[pauseUpdates.length - 1].paused;
    }

    const showImmunityHudDuration = 10 * 10;
    const spawnEnd = this.game.config().numSpawnPhaseTurns();
    const ticksSinceSpawnEnd = this.game.ticks() - spawnEnd;

    this.isImmunityActive =
      this.game.config().hasExtendedSpawnImmunity() &&
      !this.game.inSpawnPhase() &&
      this.game.isSpawnImmunityActive() &&
      ticksSinceSpawnEnd < showImmunityHudDuration;

    const currentlyCatchingUp =
      !this.game.config().isReplay() && this.game.isCatchingUp();

    if (currentlyCatchingUp) {
      this.catchingUpTicks++;
    } else {
      this.catchingUpTicks = 0;
      this.fastForwardRequested = false;
    }

    this.isCatchingUp =
      this.catchingUpTicks >= HeadsUpMessage.CATCHING_UP_SHOW_THRESHOLD;

    this.graceSeconds = this.game.myPlayer()?.pressure
      ? Math.max(
          0,
          Math.ceil(
            (this.game.config().gameConfig().pressureGraceSeconds ?? 0) -
              this.game.elapsedGameSeconds(),
          ),
        )
      : 0;
    this.isVisible =
      this.game.inSpawnPhase() ||
      this.isPaused ||
      this.isImmunityActive ||
      this.isCatchingUp ||
      this.graceSeconds > 0;
    this.requestUpdate();
  }

  private getMessage(): string {
    if (this.isCatchingUp) {
      return translateText("heads_up_message.catching_up");
    }
    if (this.isPaused) {
      if (this.game.config().gameConfig().gameType === GameType.Singleplayer) {
        return translateText("heads_up_message.singleplayer_game_paused");
      } else {
        return translateText("heads_up_message.multiplayer_game_paused");
      }
    }
    if (this.isImmunityActive) {
      return translateText("heads_up_message.pvp_immunity_active", {
        seconds: Math.round(this.game.config().spawnImmunityDuration() / 10),
      });
    }
    if (!this.game.inSpawnPhase() && this.graceSeconds > 0) {
      return `Grace ${Math.floor(this.graceSeconds / 60)}:${String(this.graceSeconds % 60).padStart(2, "0")} · wilderness and bots only`;
    }
    return this.game.config().isRandomSpawn()
      ? translateText("heads_up_message.random_spawn")
      : translateText("heads_up_message.choose_spawn");
  }

  private onCloseCollusionWarning = (): void => {
    localStorage.setItem(COLLUSION_WARNING_CLOSED_KEY, "true");
    this.hasClosedCollusionWarning = true;
    this.requestUpdate();
  };

  private onSkipCatchup = (): void => {
    if (this.fastForwardRequested) return;
    this.fastForwardRequested = true;
    window.dispatchEvent(new CustomEvent("skip-game-catchup"));
  };

  render() {
    return html`
      <div style="pointer-events: none;">
        ${
          this.toastMessage
            ? html`
                <div
                  class="fixed top-6 left-1/2 -translate-x-1/2 z-[800] px-6 py-4 rounded-xl transition-all duration-300 animate-fade-in-out"
                  style="max-width: 90vw; min-width: 200px; text-align: center;
                  background: ${
                    this.toastColor === "red"
                      ? "rgba(239,68,68,0.1)"
                      : "rgba(34,197,94,0.1)"
                  };
                  border: 1px solid ${
                    this.toastColor === "red"
                      ? "rgba(239,68,68,0.5)"
                      : "rgba(34,197,94,0.5)"
                  };
                  color: white;
                  box-shadow: 0 0 30px 0 ${
                    this.toastColor === "red"
                      ? "rgba(239,68,68,0.3)"
                      : "rgba(34,197,94,0.3)"
                  };
                  backdrop-filter: blur(12px);"
                  @contextmenu=${(e: MouseEvent) => e.preventDefault()}
                >
                  ${
                    typeof this.toastMessage === "string"
                      ? html`<span class="font-medium"
                          >${this.toastMessage}</span
                        >`
                      : this.toastMessage
                  }
                </div>
              `
            : null
        }
        ${
          this.isVisible
            ? html`
                <div
                  class="atlas-heads-up-status fixed top-[15%] left-1/2 -translate-x-1/2 z-[799]
                            inline-flex items-center justify-center min-h-8 lg:min-h-10
                            w-fit max-w-[90vw]
                            bg-gray-800/70 rounded-md lg:rounded-lg
                            backdrop-blur-xs text-white text-md lg:text-xl px-3 lg:px-4 py-1
                            text-center break-words"
                  style="word-wrap: break-word; hyphens: auto; ${
                    this.isCatchingUp
                      ? "pointer-events: auto; gap: 0.55rem;"
                      : ""
                  }"
                  @contextmenu=${(e: MouseEvent) => e.preventDefault()}
                >
                  <span>${this.getMessage()}</span>
                  ${
                    this.isCatchingUp
                      ? html`<button
                          type="button"
                          class="rounded-md border border-white/35 bg-white/15 px-3 py-1 text-sm font-semibold shadow-inner transition active:translate-y-px disabled:opacity-70"
                          ?disabled=${this.fastForwardRequested}
                          @click=${this.onSkipCatchup}
                        >
                          ${
                          this.fastForwardRequested
                            ? translateText("heads_up_message.fast_forwarding")
                            : translateText("heads_up_message.skip_catchup")
                        }
                        </button>`
                      : null
                  }
                </div>
              `
            : null
        }
        ${
          this.game?.inSpawnPhase() &&
          !this.game.config().isReplay() &&
          this.game.config().gameConfig().rankedType !== RankedType.OneVOne &&
          this.game.config().gameConfig().gameMode === GameMode.FFA &&
          this.game.config().gameConfig().gameType === GameType.Public &&
          !this.hasClosedCollusionWarning
            ? html`
                <div
                  class="fixed top-[25%] left-1/2 -translate-x-1/2 z-[799]
                            inline-flex flex-col items-center justify-center min-h-8 lg:min-h-10
                            w-fit max-w-[90vw]
                            bg-amber-500/70 rounded-md lg:rounded-lg
                            backdrop-blur-xs text-white text-md lg:text-xl px-3 lg:px-4 py-3
                            text-center break-words"
                  style="word-wrap: break-word; hyphens: auto; pointer-events: auto;"
                  @contextmenu=${(e: MouseEvent) => e.preventDefault()}
                >
                  <div>${translateText("heads_up_message.ffa_collusion")}</div>
                  <button
                    class="mt-2 px-3 py-1 rounded bg-black/20 hover:bg-black/30 text-sm"
                    @click=${this.onCloseCollusionWarning}
                  >
                    ${translateText("heads_up_message.dont_show_again")}
                  </button>
                </div>
              `
            : null
        }
      </div>
    `;
  }
}
