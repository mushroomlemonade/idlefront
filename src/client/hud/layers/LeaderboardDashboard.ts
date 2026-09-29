import { html, LitElement, nothing, svg } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { UnitType } from "../../../core/game/Game";
import type { ColumnId } from "../../StatsConstants";
import "../../styles/leaderboard-dashboard.css";
import { renderNumber, renderTroops, translateText } from "../../Utils";
import type { GameView } from "../../view";
import {
  atomBombIcon,
  claimIcon,
  hydrogenBombIcon,
  mirvIcon,
} from "../HotbarIcons";
import {
  HISTORY_WINDOWS,
  historyRange,
  valueRange,
  windowPoints,
} from "./lib/LeaderboardChart";
import {
  HISTORY_METRICS,
  type LeaderboardHistory,
} from "./lib/LeaderboardHistory";
import "./PlayerStats";
import type { PlayerStats } from "./PlayerStats";

const colors = [
  "#a8d9c5",
  "#e2bc70",
  "#93bdeb",
  "#dc9fa9",
  "#c9b4ed",
  "#ef9b72",
];
export function historyNumber(metric: ColumnId, value: number): string {
  return metric === "troops" || metric === "maxtroops"
    ? renderTroops(value)
    : renderNumber(value);
}
export function chartTime(tick: number): string {
  const seconds = Math.floor(tick / 10);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

@customElement("leaderboard-dashboard")
export class LeaderboardDashboard extends LitElement {
  @property({ attribute: false }) game: GameView | null = null;
  @property({ attribute: false }) history: LeaderboardHistory | null = null;
  @property({ type: Boolean }) open = false;
  @state() private metric: ColumnId = "tiles";
  @state() private order: "asc" | "desc" = "desc";
  @state() private windowTicks = 9000;
  @state() private fit = true;
  @state() private selectedEvent: number | null = null;
  @state() private historyError = "";
  private historyRequest = false;
  private historyRequestedAt = -Infinity;
  private historyRequestKey = "";
  @query("dialog") private dialog?: HTMLDialogElement;
  @query("player-stats") private table?: PlayerStats;
  createRenderRoot() {
    return this;
  }
  updated(changed: Map<string, unknown>) {
    if (changed.has("open") && this.open) {
      this.applySort();
    }
    if (this.open && !this.dialog?.open) this.dialog?.showModal();
    else if (!this.open && this.dialog?.open) this.dialog.close();
  }
  refresh() {
    if (this.open) {
      this.loadServerHistory();
      this.table?.refresh();
      this.requestUpdate();
    }
  }
  private loadServerHistory() {
    const game = this.game,
      history = this.history;
    if (
      !game ||
      !history ||
      !game.config().gameConfig().serverSimulation ||
      this.historyRequest
    )
      return;
    const key = `${game.gameID()}:${this.metric}:${this.order}`;
    if (
      key === this.historyRequestKey &&
      performance.now() - this.historyRequestedAt < 10000
    )
      return;
    this.historyRequest = true;
    this.historyRequestKey = key;
    this.historyRequestedAt = performance.now();
    void game.worker
      .worldHistory(
        this.metric as import("../../../core/WorldHistory").HistoryMetric,
        this.order === "asc",
      )
      .then((data) => {
        if (
          this.game !== game ||
          this.history !== history ||
          key !== `${game.gameID()}:${this.metric}:${this.order}`
        )
          return;
        if (data) history.applyServer(data);
        this.historyError = data?.restricted
          ? "historical statistics limited by fog of war"
          : "";
        this.requestUpdate();
      })
      .catch(() => {
        this.historyError = "history unavailable — retrying";
      })
      .finally(() => {
        this.historyRequest = false;
      });
  }
  private close() {
    this.open = false;
    this.dispatchEvent(new CustomEvent("dashboard-close"));
  }
  private choose(event: Event) {
    this.metric = (event.target as HTMLSelectElement).value as ColumnId;
    this.applySort();
  }
  private applySort() {
    this.history?.trackSelection(this.metric, this.order);
    this.table?.sortBy(this.metric, this.order);
    this.loadServerHistory();
  }
  private toggleOrder() {
    this.order = this.order === "desc" ? "asc" : "desc";
    this.applySort();
  }
  private chart() {
    if (!this.history) return nothing;
    const index = HISTORY_METRICS.findIndex((c) => c.id === this.metric) + 1;
    const leaders = this.history.leaders(this.metric, this.order);
    const allLines = leaders.map((row, i) => ({
      row,
      color: colors[i],
      points: this.history!.series.get(row.id)?.points ?? [],
    }));
    const points = allLines.flatMap((line) => line.points);
    if (!points.length)
      return html`<p>
        ${this.historyError || (this.game?.config().gameConfig().serverSimulation ? "loading world history…" : "collecting observed history…")}
      </p>`;
    const [first, last] = historyRange(points, this.windowTicks);
    const lines = allLines.map((line) => ({
      ...line,
      points: windowPoints(line.points, first, last),
    }));
    const [min, max] = valueRange(
      lines.flatMap((line) => line.points),
      index,
      this.fit,
    );
    const x = (tick: number) => 48 + ((tick - first) / (last - first)) * 520;
    const y = (value: number) => 232 - ((value - min) / (max - min)) * 202;
    const events = this.history.events.filter(
      (e) => e.tick >= first && e.tick <= last,
    );
    const groups = new Map<number, typeof events>();
    for (const event of events) {
      const bin = Math.min(
        6,
        Math.floor(((event.tick - first) / (last - first)) * 7),
      );
      const group = groups.get(bin) ?? [];
      group.push(event);
      groups.set(bin, group);
    }
    const eventIcon = (e: (typeof events)[number]) =>
      e.kind === "capture"
        ? claimIcon
        : e.unitType === UnitType.MIRV || e.unitType === UnitType.MIRVWarhead
          ? mirvIcon
          : e.unitType === UnitType.HydrogenBomb
            ? hydrogenBombIcon
            : atomBombIcon;
    const discrete = !["gold", "tiles", "troops", "maxtroops"].includes(
      this.metric,
    );
    return html`
      <div class="atlas-history-timeline" aria-label="event timeline">
        ${[...groups].map(([bin, group]) => {
          const event = group[group.length - 1];
          return html`<button
            type="button"
            style=${`left:${x(event.tick) / 6}%`}
            aria-label=${`${chartTime(event.tick)}: ${group.map((e) => e.text).join("; ")}`}
            @click=${() => {
              this.selectedEvent = this.selectedEvent === bin ? null : bin;
            }}
          >
            <img
              src=${eventIcon(event)}
              alt=""
            />${group.length > 1 ? html`<small>${group.length}</small>` : nothing}<span
              aria-hidden="true"
              >▾</span
            >
          </button>`;
        })}
      </div>
      <svg
        class="atlas-history-chart"
        viewBox="0 0 600 270"
        role="img"
        aria-label=${`${this.metric} history of the leading players; recorded on this device`}
      >
        ${[0, 0.25, 0.5, 0.75, 1].map((v) => min + (max - min) * v).map((v) => svg`<g><line x1="48" x2="568" y1=${y(v)} y2=${y(v)} stroke="#ffffff19"/><text x="43" y=${y(v) + 4} text-anchor="end">${historyNumber(this.metric, v)}</text></g>`)}
        ${lines.map((line) => {
          const coords = line.points.map((p) => [
            Math.max(48, x(p[0])),
            y(p[index]),
          ]);
          const d = coords
            .map(([px, py], i) =>
              i === 0
                ? `M${px},${py}`
                : discrete
                  ? `H${px}V${py}`
                  : `L${px},${py}`,
            )
            .join(" ");
          return svg`<g><path fill="none" stroke=${line.color} stroke-width="2.5" d=${d}><title>${line.row.name}</title></path>${coords.length === 1 ? svg`<circle cx=${coords[0][0]} cy=${coords[0][1]} r="4" fill=${line.color}/>` : nothing}</g>`;
        })}
        ${events.slice(-32).map((e) => svg`<g><title>${chartTime(e.tick)} · ${e.text}</title><line x1=${x(e.tick)} x2=${x(e.tick)} y1="20" y2="232" stroke="#d9a76c" stroke-dasharray="2 5" opacity=".4"/></g>`)}
        <text x="48" y="256">${chartTime(first)}</text>
        <text x="568" y="256" text-anchor="end">${chartTime(last)}</text>
      </svg>
      <div class="atlas-history-legend">
        ${lines.map((line) => html`<span><i style=${`background:${line.color}`}></i><span class="player-name">${line.row.name}</span> ${historyNumber(this.metric, line.row.values.get(this.metric) ?? 0)}</span>`)}
      </div>
      <p class="atlas-history-note">
        showing ${chartTime(first)}–${chartTime(last)} · recorded on this device
        · older samples
        simplified${lines.length > 5 ? " · includes a former leader" : ""}${this.game?.config().gameConfig().fogOfWar ? " · known assets only under fog" : ""}
      </p>
      <div class="atlas-history-events" aria-label="observed world events">
        ${(this.selectedEvent === null
          ? events
          : (groups.get(this.selectedEvent) ?? events)
        )
          .slice(-12)
          .reverse()
          .map(
            (e) =>
              html`<div>
                <img src=${eventIcon(e)} alt="" /><time
                  >${chartTime(e.tick)}</time
                >
                ${e.text}
              </div>`,
          )}
      </div>
    `;
  }
  render() {
    return html`<dialog
      class="atlas-leaderboard-dashboard"
      aria-labelledby="atlas-standings-title"
      @close=${this.close}
      @cancel=${this.close}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @pointerup=${(e: Event) => e.stopPropagation()}
      @wheel=${(e: Event) => e.stopPropagation()}
      @keydown=${(e: Event) => e.stopPropagation()}
    >
      <header>
        <h2 id="atlas-standings-title">world standings</h2>
        <button
          type="button"
          class="atlas-standings-close"
          aria-label="close fullscreen leaderboard"
          @click=${this.close}
        >
          ×
        </button>
      </header>
      <div class="atlas-standings-toolbar">
        <label
          >rank & graph
          <select
            aria-label="rank and graph metric"
            .value=${this.metric}
            @change=${this.choose}
          >
            ${HISTORY_METRICS.map((c) => html`<option value=${c.id} ?selected=${c.id === this.metric}>${c.id === "gdp" ? "gdp · asset value" : c.id === "tiles" ? "land" : translateText(c.labelKey)}</option>`)}
          </select></label
        >
        <button
          type="button"
          aria-label=${this.order === "desc" ? "sort lowest first" : "sort highest first"}
          @click=${this.toggleOrder}
        >
          ${this.order === "desc" ? "highest ↓" : "lowest ↑"}
        </button>
      </div>
      ${
        this.open
          ? html`<div class="atlas-standings-split">
              <section
                class="atlas-standings-table atlas-standings-surface"
                aria-label="all player statistics"
              >
                <player-stats
                  .game=${this.game}
                  .visible=${true}
                  .expanded=${true}
                  @leaderboard-sort=${(
                    e: CustomEvent<{ key: ColumnId; order: "asc" | "desc" }>,
                  ) => {
                    this.metric = e.detail.key;
                    this.order = e.detail.order;
                    this.history?.trackSelection(this.metric, this.order);
                  }}
                ></player-stats>
              </section>
              <section
                class="atlas-standings-history"
                aria-label="progress charts"
              >
                <div class="atlas-history-controls">
                  <label
                    >time
                    <select
                      aria-label="history time range"
                      .value=${String(this.windowTicks)}
                      @change=${(e: Event) => {
                        this.windowTicks = Number(
                          (e.target as HTMLSelectElement).value,
                        );
                        this.selectedEvent = null;
                      }}
                    >
                      ${HISTORY_WINDOWS.map((w) => html`<option value=${w.ticks} ?selected=${w.ticks === this.windowTicks}>${w.label}</option>`)}
                    </select></label
                  >
                  <label
                    >scale
                    <select
                      aria-label="history vertical scale"
                      .value=${this.fit ? "fit" : "zero"}
                      @change=${(e: Event) => {
                        this.fit =
                          (e.target as HTMLSelectElement).value === "fit";
                      }}
                    >
                      <option value="fit">fit changes</option>
                      <option value="zero">from zero</option>
                    </select></label
                  >
                </div>
                ${this.chart()}
                ${this.metric === "gdp" ? html`<p class="atlas-history-note">gdp = completed structures and warships at standard first-unit prices × levels. excludes cash and expendable weapons; not income or historical spending.</p>` : nothing}
              </section>
            </div>`
          : nothing
      }
    </dialog>`;
  }
}
