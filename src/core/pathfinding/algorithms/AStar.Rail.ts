import { GameMap } from "../../game/GameMap";
import { DebugSpan } from "../../utilities/DebugSpan";
import { PathFinder } from "../types";
import { AStar, AStarAdapter } from "./AStar";
import { RailConnectivity } from "./RailConnectivity";
import { SparseAStar } from "./SparseAStar";

export class AStarRail implements PathFinder<number> {
  private readonly aStar: AStar | SparseAStar;
  private readonly connectivity?: RailConnectivity;
  readonly metrics = { queries: 0, disconnected: 0 };

  constructor(gameMap: GameMap) {
    const adapter = new RailAdapter(gameMap);
    // Dense scratch is faster for small maps; cap it at 64 MiB. Huge maps use
    // visited-node storage instead of allocating 16 bytes for every mini tile.
    this.aStar =
      adapter.numNodes() <= 4_000_000
        ? new AStar({ adapter })
        : new SparseAStar({ adapter });
    // No filter without reliable terrain notifications, or above the bounded
    // 320 MiB index budget. The sparse exact search remains the fallback.
    if (
      gameMap.observeTerrain &&
      gameMap.width() * gameMap.height() <= 64_000_000
    )
      this.connectivity = new RailConnectivity(gameMap);
  }

  findPath(from: number | number[], to: number): number[] | null {
    this.metrics.queries++;
    if (this.connectivity && !this.connectivity.mayConnect(from, to)) {
      this.metrics.disconnected++;
      return null;
    }
    return DebugSpan.wrap("AStar.Rail:findPath", () =>
      this.aStar.findPath(from, to),
    );
  }
}

// Internal adapter
export class RailAdapter implements AStarAdapter {
  private readonly gameMap: GameMap;
  private readonly width: number;
  private readonly height: number;
  private readonly _numNodes: number;
  private readonly waterPenalty = 5;
  private readonly heuristicWeight = 2;
  private readonly directionChangePenalty = 3;

  constructor(gameMap: GameMap) {
    this.gameMap = gameMap;
    this.width = gameMap.width();
    this.height = gameMap.height();
    this._numNodes = this.width * this.height;
  }

  numNodes(): number {
    return this._numNodes;
  }

  maxNeighbors(): number {
    return 4;
  }

  maxPriority(): number {
    const maxCost = 1 + this.waterPenalty + this.directionChangePenalty;
    return this.heuristicWeight * (this.width + this.height) * maxCost;
  }

  neighbors(node: number, buffer: Int32Array): number {
    let count = 0;
    const x = node % this.width;
    const fromShoreline = this.gameMap.isShoreline(node);
    const isImpassable = this.gameMap.isImpassable(node);

    if (node >= this.width) {
      const n = node - this.width;
      if (this.isTraversable(n, fromShoreline, isImpassable))
        buffer[count++] = n;
    }
    if (node < this._numNodes - this.width) {
      const n = node + this.width;
      if (this.isTraversable(n, fromShoreline, isImpassable))
        buffer[count++] = n;
    }
    if (x !== 0) {
      const n = node - 1;
      if (this.isTraversable(n, fromShoreline, isImpassable))
        buffer[count++] = n;
    }
    if (x !== this.width - 1) {
      const n = node + 1;
      if (this.isTraversable(n, fromShoreline, isImpassable))
        buffer[count++] = n;
    }

    return count;
  }

  private isTraversable(
    to: number,
    fromShoreline: boolean,
    isImpassable: boolean,
  ): boolean {
    if (isImpassable) return false;
    const toWater = this.gameMap.isWater(to);
    if (!toWater) return true;
    return fromShoreline || this.gameMap.isShoreline(to);
  }

  cost(from: number, to: number, prev?: number): number {
    const penalized = this.gameMap.isWater(to) || this.gameMap.isShoreline(to);
    let c = penalized ? 1 + this.waterPenalty : 1;

    if (prev !== undefined) {
      const d1 = from - prev;
      const d2 = to - from;
      if (d1 !== d2) {
        c += this.directionChangePenalty;
      }
    }

    return c;
  }

  heuristic(node: number, goal: number): number {
    const nx = node % this.width;
    const ny = (node / this.width) | 0;
    const gx = goal % this.width;
    const gy = (goal / this.width) | 0;
    return this.heuristicWeight * (Math.abs(nx - gx) + Math.abs(ny - gy));
  }
}
