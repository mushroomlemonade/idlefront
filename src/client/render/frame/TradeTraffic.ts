import type { UnitState } from "../types/Renderer";
import { TrainType } from "../types/Renderer";

interface Edge {
  a: number;
  b: number;
  sea: boolean;
  visits: number;
  tick: number;
}
/** Observed traffic only, with a fixed memory ceiling. Never changes unit state.
 * Sparse edges avoid a world-sized heatmap texture on mobile. */
export class TradeTraffic {
  private edges = new Map<string, Edge>();
  private lastTick = -1;
  private positions = new Map<number, number>();
  private lastUpload = -Infinity;
  private data = new Float32Array(0);
  constructor(
    private width: number,
    private limit = 12000,
  ) {}
  reset() {
    this.edges.clear();
    this.positions.clear();
    this.lastTick = -1;
    this.lastUpload = -Infinity;
  }
  update(
    tick: number,
    units: ReadonlyMap<number, UnitState>,
    visible: (tile: number) => boolean,
    idleTicks = 18000,
    hotTrips = 8,
    recheckVisibility = false,
  ): Float32Array {
    if (tick !== this.lastTick) {
      this.lastTick = tick;
      for (const u of units.values()) {
        const sea = u.unitType === "Trade Ship";
        if (
          !sea &&
          !(u.unitType === "Train" && u.trainType === TrainType.Engine)
        )
          continue;
        const previous = this.positions.get(u.id);
        this.positions.delete(u.id);
        if (u.isActive) this.positions.set(u.id, u.pos);
        if (this.positions.size > 16000)
          this.positions.delete(this.positions.keys().next().value!);
        // A static unit can retain lastPos across many server ticks.
        if (previous === u.pos) continue;
        if (
          !u.isActive ||
          u.pos === u.lastPos ||
          !visible(u.pos) ||
          !visible(u.lastPos)
        )
          continue;
        // A motion-plan correction must never paint a cross-map corridor.
        const ax = u.pos % this.width,
          bx = u.lastPos % this.width;
        if (
          Math.abs(ax - bx) +
            Math.abs(
              Math.floor(u.pos / this.width) -
                Math.floor(u.lastPos / this.width),
            ) >
          6
        )
          continue;
        const a = Math.min(u.pos, u.lastPos),
          b = Math.max(u.pos, u.lastPos),
          key = `${sea ? 1 : 0}:${a}:${b}`;
        const old = this.edges.get(key);
        const visits =
          old && tick - old.tick <= idleTicks
            ? Math.min(hotTrips * 8, old.visits + 1)
            : 1;
        this.edges.delete(key);
        this.edges.set(key, { a, b, sea, visits, tick });
        if (this.edges.size > this.limit)
          this.edges.delete(this.edges.keys().next().value!);
      }
    }
    if (!recheckVisibility && tick - this.lastUpload < 10) return this.data;
    this.lastUpload = tick;
    const values: number[] = [];
    for (const [key, e] of this.edges) {
      if (tick - e.tick > idleTicks) {
        this.edges.delete(key);
        continue;
      }
      if (!visible(e.a) || !visible(e.b)) continue;
      const heat =
        Math.min(1, e.visits / hotTrips) *
        Math.max(0, 1 - (tick - e.tick) / idleTicks);
      values.push(
        (e.a % this.width) + 0.5,
        Math.floor(e.a / this.width) + 0.5,
        (e.b % this.width) + 0.5,
        Math.floor(e.b / this.width) + 0.5,
        heat,
        e.sea ? 1 : 0,
      );
    }
    this.data = Float32Array.from(values);
    return this.data;
  }
}
