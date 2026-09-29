import { ASSET_VALUE } from "../../core/AssetValue";
import { PlayerType, UnitType, type Game } from "../../core/game/Game";
import {
  GameUpdateType,
  type GameUpdateViewData,
} from "../../core/game/GameUpdates";
import {
  compactWorldHistory,
  WORLD_HISTORY_METRICS,
  type HistoryMetric,
  type WorldHistoryResponse,
} from "../../core/WorldHistory";

/** Reconstructed deterministically during journal recovery, even with zero viewers.
 * <=512 series x 256 points x 14 doubles (~14MiB worst-case); query <=7 series.
 * Nations/humans retained first, then leading tribes. No client-device ownership. */
export class WorldHistory {
  private startTick = 0;
  private sampled = -1;
  private readonly series = new Map<string, Float64Array[]>();
  private readonly nukes = new Set<number>();
  private readonly captures = new Map<number, number>();
  private readonly events: WorldHistoryResponse["events"] = [];
  constructor(private game: Game) {}
  record(update: GameUpdateViewData): void {
    this.startTick =
      update.updates[GameUpdateType.SpawnPhaseEnd][0]?.startTick ??
      this.startTick;
    for (const u of update.updates[GameUpdateType.Unit]) {
      if (
        [
          UnitType.AtomBomb,
          UnitType.HydrogenBomb,
          UnitType.MIRV,
          UnitType.MIRVWarhead,
        ].includes(u.unitType)
      ) {
        const known = this.nukes.has(u.id);
        if ((u.isActive && !known) || (!u.isActive && known)) {
          this.events.push({
            tick: update.tick - this.startTick,
            kind: "nuke",
            unitType: u.unitType,
            text: `${u.unitType.toLowerCase()} ${u.isActive ? "launched" : u.reachedTarget ? "impact" : "intercepted / ended"}`,
          });
          if (u.isActive && this.nukes.size < 2048) this.nukes.add(u.id);
          else if (!u.isActive) this.nukes.delete(u.id);
        }
      }
      if (
        u.isActive &&
        u.lastOwnerID !== undefined &&
        u.lastOwnerID !== u.ownerID &&
        this.captures.get(u.id) !== u.ownerID &&
        [
          UnitType.City,
          UnitType.Port,
          UnitType.Factory,
          UnitType.SAMLauncher,
          UnitType.MissileSilo,
          UnitType.DefensePost,
        ].includes(u.unitType)
      ) {
        this.captures.set(u.id, u.ownerID);
        if (this.captures.size > 8192)
          this.captures.delete(this.captures.keys().next().value!);
        this.events.push({
          tick: update.tick - this.startTick,
          kind: "capture",
          text: `${u.unitType.toLowerCase()} changed hands`,
        });
      }
      if (!u.isActive) this.captures.delete(u.id);
    }
    if (this.events.length > 128)
      this.events.splice(0, this.events.length - 128);
    if (
      this.game.inSpawnPhase() ||
      update.tick % 100 !== 0 ||
      update.tick <= this.sampled
    )
      return;
    this.sampled = update.tick;
    const players = this.game.players().filter((p) => p.isAlive());
    const protectedIDs = new Set(
      this.game
        .allPlayers()
        .filter((p) => p.type() !== PlayerType.Bot)
        .slice(0, 448)
        .map((p) => p.id()),
    );
    const wanted = players.filter((p) => protectedIDs.has(p.id()));
    const tribes = players
      .filter((p) => p.type() === PlayerType.Bot)
      .sort(
        (a, b) =>
          b.numTilesOwned() - a.numTilesOwned() || a.smallID() - b.smallID(),
      )
      .slice(0, 64);
    for (const p of [...wanted, ...tribes]) {
      if (!this.series.has(p.id()) && this.series.size >= 512) {
        // Evict only an unselected tribe; never discard an established nation's history.
        const victim = [...this.series.keys()].find(
          (id) => !protectedIDs.has(id) && !tribes.some((p) => p.id() === id),
        );
        if (!victim) continue;
        this.series.delete(victim);
      }
      const levels = new Map<UnitType, number>();
      let gdp = 0;
      for (const u of p.units())
        if (u.isActive() && !u.isUnderConstruction()) {
          levels.set(u.type(), (levels.get(u.type()) ?? 0) + u.level());
          gdp += (ASSET_VALUE[u.type()] ?? 0) * u.level();
        }
      const n = (t: UnitType) => levels.get(t) ?? 0;
      const point = Float64Array.from([
        update.tick - this.startTick,
        p.numTilesOwned(),
        Number(p.gold()),
        p.troops(),
        gdp,
        this.game.config().maxTroops(p),
        n(UnitType.City),
        n(UnitType.Port),
        n(UnitType.Factory),
        n(UnitType.MissileSilo),
        n(UnitType.SAMLauncher),
        n(UnitType.Warship),
        p.allies().length,
        p.betrayals(),
      ]);
      const points = compactWorldHistory(this.series.get(p.id()) ?? []);
      points.push(point);
      this.series.set(p.id(), points);
    }
  }
  query(
    metric: HistoryMetric,
    ascending: boolean,
    ownID?: string,
    restricted = false,
  ): WorldHistoryResponse {
    const index = WORLD_HISTORY_METRICS.indexOf(metric) + 1;
    const alive = new Set(
      this.game
        .players()
        .filter((p) => p.isAlive())
        .map((p) => p.id()),
    );
    const entries = [...this.series].filter(
      ([id]) => !restricted || id === ownID,
    );
    const ranked = entries
      .filter(([id]) => alive.has(id))
      .sort(
        (a, b) =>
          (ascending ? 1 : -1) *
            ((a[1][a[1].length - 1]?.[index] ?? 0) -
              (b[1][b[1].length - 1]?.[index] ?? 0)) ||
          a[0].localeCompare(b[0]),
      );
    const ids = new Set(ranked.slice(0, 5).map(([id]) => id));
    if (ownID) ids.add(ownID);
    if (!ascending) {
      const former = entries
        .filter(([id]) => !ids.has(id))
        .sort(
          (a, b) =>
            Math.max(...b[1].map((p) => p[index])) -
            Math.max(...a[1].map((p) => p[index])),
        )[0];
      if (former) ids.add(former[0]);
    }
    return {
      tick: Math.max(0, this.sampled - this.startTick),
      metrics: WORLD_HISTORY_METRICS.join(","),
      restricted,
      events: restricted ? [] : this.events.slice(),
      series: entries
        .filter(([id]) => ids.has(id))
        .map(([id, points]) => ({ id, points })),
    };
  }
}
