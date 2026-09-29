import { Colord } from "colord";
import { html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { assetUrl } from "../../../core/AssetUrls";
import type { EventBus } from "../../../core/EventBus";
import { GameMode, type Team } from "../../../core/game/Game";
import { recordDeveloperMenuLogoTap } from "../../components/DeveloperMenu";
import type { Controller } from "../../Controller";
import { themeProvider } from "../../theme/ThemeProvider";
import { getTranslatedPlayerTeamLabel, translateText } from "../../Utils";
import type { GameView } from "../../view";
import { ImmunityBarVisibleEvent } from "./ImmunityTimer";
import "./LeaderboardDashboard";
import type { LeaderboardDashboard } from "./LeaderboardDashboard";
import { LeaderboardHistory } from "./lib/LeaderboardHistory";
import { LeaderboardHistoryStore } from "./lib/LeaderboardHistoryStore";
import "./PlayerStats";
import type { PlayerStats } from "./PlayerStats";
import { SpawnBarVisibleEvent } from "./SpawnTimer";
import "./TeamStats";
import type { TeamStats } from "./TeamStats";
const teamStatsRegularIcon = assetUrl("images/TeamIconRegularWhite.svg");
const teamStatsSolidIcon = assetUrl("images/TeamIconSolidWhite.svg");

@customElement("game-left-sidebar")
export class GameLeftSidebar extends LitElement implements Controller {
  @state()
  private isPlayerStatsShown = false;
  @state()
  private isTeamStatsShown = false;
  @state()
  private isVisible = false;
  @state()
  private isPlayerTeamLabelVisible = false;
  @state()
  private playerTeam: Team | null = null;
  @state()
  private spawnBarVisible = false;
  @state()
  private immunityBarVisible = false;
  @state()
  private leaderboardRank: number | null = null;
  @state() private dashboardOpen = false;
  private history = new LeaderboardHistory();
  private historyGame: GameView | null = null;
  private stopHistory?: () => void;
  private historyStore = new LeaderboardHistoryStore();
  private historyKey = "";
  private lastHistorySave = 0;
  private persistHistory = () => {
    if (this.game?.config().gameConfig().serverSimulation) return;
    if (this.historyKey)
      void this.historyStore.save(this.historyKey, this.history.snapshot());
  };
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.persistHistory);
    window.addEventListener("pagehide", this.persistHistory);
  }
  @query("leaderboard-dashboard") private dashboard?: LeaderboardDashboard;

  disconnectedCallback() {
    this.persistHistory();
    document.removeEventListener("visibilitychange", this.persistHistory);
    window.removeEventListener("pagehide", this.persistHistory);
    super.disconnectedCallback();
    this.stopHistory?.();
    this.historyGame = null;
  }

  private playerColor: Colord = new Colord("#FFFFFF");
  @property({ attribute: false }) public game: GameView | null = null;
  @property({ attribute: false }) public eventBus: EventBus | null = null;
  @query("player-stats") private playerStats?: PlayerStats;
  @query("team-stats") private teamStats?: TeamStats;

  createRenderRoot() {
    return this;
  }

  init() {
    this.isVisible = true;
    this.eventBus?.on(SpawnBarVisibleEvent, (e) => {
      this.spawnBarVisible = e.visible;
    });
    this.eventBus?.on(ImmunityBarVisibleEvent, (e) => {
      this.immunityBarVisible = e.visible;
    });
    if (this.isTeamGame) {
      this.isPlayerTeamLabelVisible = true;
    }
    // The map leads on every screen; standings open only on request.
  }

  getTickIntervalMs() {
    return 1000;
  }

  tick() {
    if (this.game === null) return;
    const key = `${this.game.gameID()}:${this.game.myPlayer()?.id() ?? "spectator"}:${this.game.config().gameConfig().fogOfWar ?? "public"}`;
    if (this.historyGame !== this.game || key !== this.historyKey) {
      this.persistHistory();
      this.stopHistory?.();
      this.history = new LeaderboardHistory();
      this.historyKey = key;
      const history = this.history;
      if (!this.game.config().gameConfig().serverSimulation)
        void this.historyStore.load(key).then((saved) => {
          if (saved && this.history === history) {
            history.restore(saved);
            this.dashboard?.refresh();
          }
        });
      this.historyGame = this.game;
      this.stopHistory = this.game.observeUpdates((update) =>
        this.history.observe(this.game!, update),
      );
    }
    if (Date.now() - this.lastHistorySave > 30000) {
      this.lastHistorySave = Date.now();
      this.persistHistory();
    }
    this.dashboard?.refresh();

    const team = this.game.myPlayer()?.team();
    if (this.playerTeam === null && team !== null && team !== undefined) {
      this.playerTeam = team;
      this.playerColor = themeProvider.current().teamColor(team);
    }

    if (!this.game.inSpawnPhase() && this.isPlayerTeamLabelVisible) {
      this.isPlayerTeamLabelVisible = false;
    }

    this.playerStats?.refresh(true);
    this.teamStats?.refresh();
  }

  private get barOffset(): number {
    return (this.spawnBarVisible ? 7 : 0) + (this.immunityBarVisible ? 7 : 0);
  }

  private togglePlayerStats(): void {
    this.isPlayerStatsShown = !this.isPlayerStatsShown;
  }

  private onLogoTap(event: PointerEvent): void {
    recordDeveloperMenuLogoTap(performance.now(), {
      x: event.clientX,
      y: event.clientY,
    });
  }

  private toggleTeamStats(): void {
    this.isTeamStatsShown = !this.isTeamStatsShown;
  }

  private get isTeamGame(): boolean {
    return this.game?.config().gameConfig().gameMode === GameMode.Team;
  }

  render() {
    return html`
      <aside
        class=${`atlas-game-overview fixed top-0 min-[1200px]:top-4 left-0 min-[1200px]:left-4 z-900 flex flex-col max-h-[calc(100vh-80px)] overflow-y-auto p-2 bg-gray-800/92 backdrop-blur-sm shadow-xs min-[1200px]:rounded-lg rounded-br-lg ${this.isPlayerStatsShown || this.isTeamStatsShown ? "max-[400px]:w-full max-[400px]:rounded-none" : ""} transition-all duration-300 ease-out transform ${
          this.isVisible ? "translate-x-0" : "hidden"
        }`}
        style="margin-top: ${this.barOffset}px;"
      >
        <div class="atlas-overview-actions flex items-center text-white">
          <button
            class="atlas-hud-button atlas-nav-rank"
            type="button"
            role="button"
            aria-label=${this.isPlayerStatsShown ? "Close leaderboard" : this.leaderboardRank === null ? "Open leaderboard" : `Leaderboard: position ${this.leaderboardRank}`}
            aria-expanded=${this.isPlayerStatsShown}
            title="Leaderboard"
            @pointerup=${this.onLogoTap}
            @click=${this.togglePlayerStats}
          >
            ${keyed(
              this.isPlayerStatsShown,
              html`<span
                class="atlas-leaderboard-rank ${this.isPlayerStatsShown ? "is-close" : ""}"
                aria-hidden="true"
                >${this.isPlayerStatsShown ? "×" : this.leaderboardRank === null ? html`<img src=${assetUrl("images/LeaderboardIconRegularWhite.svg")} width="20" height="20" alt="" />` : `#${this.leaderboardRank}`}</span
              >`,
            )}
          </button>
          ${
            this.isTeamGame
              ? html`
                  <button
                    class="atlas-hud-button"
                    type="button"
                    role="button"
                    aria-expanded=${this.isTeamStatsShown}
                    @click=${this.toggleTeamStats}
                  >
                    <img
                      src=${
                        this.isTeamStatsShown
                          ? teamStatsSolidIcon
                          : teamStatsRegularIcon
                      }
                      alt=${
                        translateText("help_modal.icon_alt_team_leaderboard") ||
                        "Team Leaderboard Icon"
                      }
                      width="20"
                      height="20"
                    />
                  </button>
                `
              : null
          }
          ${
            this.isPlayerStatsShown || this.isTeamStatsShown
              ? html`<span
                  class="ml-auto text-[10px] text-slate-500 select-all leading-none self-start"
                  title=${translateText("help_modal.game_id_tooltip")}
                  >${this.game?.gameID() ?? ""}</span
                >`
              : null
          }
        </div>
        ${
          this.isPlayerTeamLabelVisible
            ? html`
                <div
                  class="flex items-center w-full text-white mt-2"
                  @contextmenu=${(e: Event) => e.preventDefault()}
                >
                  ${translateText("help_modal.ui_your_team")}
                  <span
                    style="--color: ${this.playerColor.toRgbString()}"
                    class="text-(--color)"
                  >
                    &nbsp;${getTranslatedPlayerTeamLabel(this.playerTeam)}
                    &#10687;
                  </span>
                </div>
              `
            : null
        }
        <div
          class="atlas-leaderboard-flyout flex flex-col gap-2 min-w-0 w-full"
        >
          ${
            this.isPlayerStatsShown
              ? html`<button
                  class="atlas-leaderboard-expand"
                  type="button"
                  @click=${() => {
                    this.dashboardOpen = true;
                  }}
                >
                  fullscreen & charts
                </button>`
              : null
          }
          <player-stats
            .compact=${true}
            @leaderboard-rank=${(
              event: CustomEvent<{ rank: number | null }>,
            ) => {
              this.leaderboardRank = event.detail.rank;
            }}
            class=${this.isPlayerStatsShown ? "block min-w-0" : "hidden"}
            .game=${this.game}
            .eventBus=${this.eventBus}
            .visible=${this.isPlayerStatsShown}
          ></player-stats>
          <team-stats
            class=${
              this.isTeamStatsShown && this.isTeamGame
                ? "block min-w-0"
                : "hidden"
            }
            .game=${this.game}
            .visible=${this.isTeamStatsShown && this.isTeamGame}
          ></team-stats>
        </div>
        <slot></slot>
      </aside>
      <leaderboard-dashboard
        .game=${this.game}
        .history=${this.history}
        .open=${this.dashboardOpen}
        @dashboard-close=${() => {
          this.dashboardOpen = false;
        }}
      ></leaderboard-dashboard>
    `;
  }
}
