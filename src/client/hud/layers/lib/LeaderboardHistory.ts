import { UnitType } from "../../../../core/game/Game";
import {
  GameUpdateType,
  type GameUpdateViewData,
} from "../../../../core/game/GameUpdates";
import type { ColumnId } from "../../../StatsConstants";
import type { GameView } from "../../../view";
import { COLUMN_DEFS, columnValues } from "./StatsColumns";

export const HISTORY_METRICS = COLUMN_DEFS.filter((c) => c.value !== undefined);
export interface HistoryRow {
  id: string;
  name: string;
  values: ReadonlyMap<ColumnId, number>;
}
export interface HistorySeries {
  name: string;
  points: Float64Array[];
  lastSeen: number;
}
export interface HistoryEvent {
  tick: number;
  text: string;
  kind: "nuke" | "capture";
  unitType?: UnitType;
}
const MAX_SERIES = 64,
  MAX_POINTS = 384,
  MAX_EVENTS = 128;
const NUKES = new Set([
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.MIRVWarhead,
]);

export interface HistorySnapshot {
  version: 1;
  metrics: string;
  tick: number;
  series: Array<{
    id: string;
    name: string;
    lastSeen: number;
    points: Float64Array[];
  }>;
  events: HistoryEvent[];
}

/** Keep the more informative sample in each old pair, not blindly every other
 * point. A sharp asset loss should survive progressive history compaction. */
export function compactHistory(points: Float64Array[]): Float64Array[] {
  while (points.length > 383) {
    const older = [points[0]];
    for (let i = 1; i < 255; i += 2) {
      const left = points[i - 1],
        right = points[i + 2];
      const error = (p: Float64Array) => {
        const fraction = (p[0] - left[0]) / Math.max(1, right[0] - left[0]);
        let score = 0;
        for (let j = 1; j < p.length; j++)
          score = Math.max(
            score,
            Math.abs(p[j] - (left[j] + (right[j] - left[j]) * fraction)) /
              Math.max(1, Math.abs(left[j]), Math.abs(right[j])),
          );
        return score;
      };
      older.push(
        error(points[i]) >= error(points[i + 1]) ? points[i] : points[i + 1],
      );
    }
    points = older.concat(points.slice(255));
  }
  return points;
}

/** Server-owned history for remote worlds; bounded session fallback for local games. */
export class LeaderboardHistory {
  applyServer(
    data: import("../../../../core/WorldHistory").WorldHistoryResponse,
  ): void {
    if (data.metrics !== HISTORY_METRICS.map((c) => c.id).join(",")) return;
    this.series.clear();
    this.events.splice(0, this.events.length, ...data.events);
    for (const saved of data.series)
      this.series.set(saved.id, {
        name: this.rows.find((r) => r.id === saved.id)?.name ?? "nation",
        points: saved.points,
        lastSeen: data.tick,
      });
  }
  readonly series = new Map<string, HistorySeries>();
  readonly events: HistoryEvent[] = [];
  private readonly activeNukes = new Set<number>();
  private readonly captureOwners = new Map<number, number>();
  private lastTick = -Infinity;
  private lastEventTick = -1;
  private forceSample = false;
  private selection: { metric: ColumnId; order: "asc" | "desc" } | undefined;
  rows: HistoryRow[] = [];

  snapshot(): HistorySnapshot {
    return {
      version: 1,
      metrics: HISTORY_METRICS.map((c) => c.id).join(","),
      tick: this.lastTick,
      series: [...this.series].map(([id, s]) => ({
        id,
        ...s,
        points: s.points.slice(),
      })),
      events: this.events.slice(),
    };
  }

  restore(snapshot: HistorySnapshot): void {
    if (
      snapshot?.version !== 1 ||
      snapshot.metrics !== HISTORY_METRICS.map((c) => c.id).join(",") ||
      !Number.isFinite(snapshot.tick) ||
      !Array.isArray(snapshot.series) ||
      snapshot.series.length > MAX_SERIES
    )
      return;
    for (const saved of snapshot.series) {
      if (
        !saved ||
        typeof saved.id !== "string" ||
        typeof saved.name !== "string" ||
        !Array.isArray(saved.points) ||
        saved.points.length > MAX_POINTS
      )
        continue;
      const valid = saved.points.filter(
        (p) =>
          p instanceof Float64Array &&
          p.length === HISTORY_METRICS.length + 1 &&
          [...p].every(Number.isFinite) &&
          p[0] >= 0,
      );
      if (!valid.length) continue;
      const live = this.series.get(saved.id);
      const byTick = new Map(valid.map((p) => [p[0], p]));
      for (const p of live?.points ?? []) byTick.set(p[0], p);
      if (!live && this.series.size >= MAX_SERIES) continue;
      this.series.set(saved.id, {
        name: live?.name ?? saved.name,
        lastSeen: live?.lastSeen ?? snapshot.tick,
        points: compactHistory(
          [...byTick.values()].sort((a, b) => a[0] - b[0]),
        ),
      });
    }
    if (Array.isArray(snapshot.events)) {
      const events = [
        ...snapshot.events.slice(-MAX_EVENTS),
        ...this.events,
      ].filter(
        (e) =>
          e &&
          Number.isFinite(e.tick) &&
          e.tick >= 0 &&
          (e.kind === "nuke" || e.kind === "capture") &&
          typeof e.text === "string" &&
          e.text.length <= 512,
      );
      const unique = new Map(
        events.map((e) => [`${e.tick}:${e.kind}:${e.text}`, e]),
      );
      this.events.splice(
        0,
        this.events.length,
        ...[...unique.values()]
          .sort((a, b) => a.tick - b.tick)
          .slice(-MAX_EVENTS),
      );
    }
  }

  trackSelection(metric: ColumnId, order: "asc" | "desc"): void {
    this.selection = { metric, order };
    this.forceSample = true;
  }

  observe(game: GameView, update: GameUpdateViewData): void {
    if (game.inSpawnPhase()) return;
    const tick = game.ticksSinceStart();
    if (update.fog?.resetUnits) {
      this.activeNukes.clear();
      this.captureOwners.clear();
    }
    if (!update.snapshotPhase && tick > this.lastEventTick) {
      this.lastEventTick = tick;
      let captures = 0;
      for (const unit of update.updates[GameUpdateType.Unit]) {
        if (NUKES.has(unit.unitType)) {
          const known = this.activeNukes.has(unit.id);
          const owner = game.playerBySmallID(unit.ownerID);
          const name = owner.isPlayer() ? owner.name() : "unknown";
          if (unit.isActive && !known) {
            // 'Detected' is honest even when fog reveals a missile mid-flight.
            this.addEvent({
              tick,
              kind: "nuke",
              unitType: unit.unitType,
              text: `${name}: ${unit.unitType.toLowerCase()} detected`,
            });
            if (this.activeNukes.size < 2048) this.activeNukes.add(unit.id);
          } else if (!unit.isActive && known) {
            this.addEvent({
              tick,
              kind: "nuke",
              unitType: unit.unitType,
              text: `${name}: ${unit.unitType.toLowerCase()} ${unit.reachedTarget ? "impact" : "ended / intercepted"}`,
            });
            this.activeNukes.delete(unit.id);
          }
        }
        if (
          unit.isActive &&
          unit.lastOwnerID !== undefined &&
          unit.lastOwnerID !== unit.ownerID &&
          [
            UnitType.City,
            UnitType.Factory,
            UnitType.Port,
            UnitType.SAMLauncher,
            UnitType.MissileSilo,
            UnitType.DefensePost,
          ].includes(unit.unitType) &&
          this.captureOwners.get(unit.id) !== unit.ownerID
        ) {
          captures++;
          this.captureOwners.set(unit.id, unit.ownerID);
          if (this.captureOwners.size > 4096)
            this.captureOwners.delete(this.captureOwners.keys().next().value!);
        }
        if (!unit.isActive) this.captureOwners.delete(unit.id);
      }
      if (captures)
        this.addEvent({
          tick,
          kind: "capture",
          text: `${captures} structures changed hands`,
        });
    }
    // One sample per second at most, even for clustered MIRV submunitions.
    const slow =
      (game.config().gameConfig().pressurePacing?.populationGrowthMultiplier ??
        1) < 1;
    if (update.snapshotPhase && update.snapshotPhase !== "end") return;
    if (tick - this.lastTick < (this.forceSample ? 10 : slow ? 50 : 10)) return;
    this.forceSample = false;
    const rows = game
      .players()
      .filter((p) => p.isAlive())
      .map((p) => ({
        id: p.id(),
        name: p.name(),
        values: columnValues(p, game, HISTORY_METRICS),
      }));
    if (game.config().gameConfig().serverSimulation) {
      this.rows = rows;
      this.lastTick = tick;
    } else this.sample(tick, rows);
  }

  private addEvent(event: HistoryEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.forceSample = true;
  }

  sample(tick: number, rows: HistoryRow[]): void {
    if (tick <= this.lastTick) return;
    this.lastTick = tick;
    this.rows = rows;
    const wanted = new Set<string>();
    if (this.selection) {
      const { metric, order } = this.selection;
      const sign = order === "desc" ? -1 : 1;
      const selected: HistoryRow[] = [];
      for (const row of rows) {
        let at = selected.findIndex(
          (r) =>
            sign *
              ((row.values.get(metric) ?? 0) - (r.values.get(metric) ?? 0)) <
            0,
        );
        if (at < 0) at = selected.length;
        if (at < 5) {
          selected.splice(at, 0, row);
          if (selected.length > 5) selected.pop();
        }
      }
      for (const row of selected) wanted.add(row.id);
    }
    for (const column of HISTORY_METRICS) {
      // Bounded top-five selection, not fifteen full 3000-player sorts.
      const top: HistoryRow[] = [];
      for (const row of rows) {
        const value = row.values.get(column.id) ?? 0;
        let at = top.findIndex((r) => value > (r.values.get(column.id) ?? 0));
        if (at < 0) at = top.length;
        if (at < 5) {
          top.splice(at, 0, row);
          if (top.length > 5) top.pop();
        }
      }
      for (const row of top) wanted.add(row.id);
    }
    // Selected chart rows have first claim on the bounded history slots.
    [...wanted].slice(MAX_SERIES).forEach((id) => wanted.delete(id));
    const byID = new Map(rows.map((row) => [row.id, row]));
    for (const id of wanted) {
      if (this.series.has(id)) continue;
      if (this.series.size >= MAX_SERIES) {
        const victim = [...this.series]
          .filter(([key]) => !wanted.has(key))
          .sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
        if (!victim) break;
        this.series.delete(victim[0]);
      }
      this.series.set(id, {
        name: byID.get(id)!.name,
        points: [],
        lastSeen: tick,
      });
    }
    for (const [id, series] of this.series) {
      const row = byID.get(id);
      // Unknown/dead/fogged rows are gaps, never fabricated zeroes.
      if (!row) continue;
      series.name = row.name;
      if (wanted.has(id)) series.lastSeen = tick;
      if (series.points.length >= MAX_POINTS) {
        series.points = compactHistory(series.points);
      }
      series.points.push(
        Float64Array.from([
          tick,
          ...HISTORY_METRICS.map((c) => row.values.get(c.id) ?? 0),
        ]),
      );
    }
  }

  leaders(metric: ColumnId, order: "asc" | "desc" = "desc"): HistoryRow[] {
    const sign = order === "desc" ? -1 : 1;
    const leaders = [...this.rows]
      .sort(
        (a, b) =>
          sign * ((a.values.get(metric) ?? 0) - (b.values.get(metric) ?? 0)),
      )
      .slice(0, 5);
    // Retain one fallen leader: a nuclear collapse should not erase its line
    // merely because it dropped out of today's top five. No hidden players.
    if (order === "desc" && leaders.length === 5) {
      const field = HISTORY_METRICS.findIndex((c) => c.id === metric) + 1;
      let peak = leaders[4].values.get(metric) ?? 0;
      let former: HistoryRow | undefined;
      const live = new Map(this.rows.map((r) => [r.id, r]));
      for (const [id, series] of this.series) {
        if (!live.has(id) || leaders.some((r) => r.id === id)) continue;
        const max = Math.max(0, ...series.points.map((p) => p[field]));
        if (max > peak) {
          peak = max;
          former = live.get(id);
        }
      }
      if (former) leaders.push(former);
    }
    return leaders;
  }
}
