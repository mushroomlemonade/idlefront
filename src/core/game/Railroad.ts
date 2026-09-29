import { Game } from "./Game";
import { TileRef } from "./GameMap";
import { GameUpdateType } from "./GameUpdates";
import { TrainStation } from "./TrainStation";

export class Railroad {
  public trips = 0;
  public lastTripTick = 0;
  private replacementSegments?: readonly Railroad[];
  private destroyed = false;

  /** A station inserted into an intact track must not cancel trains already
   * travelling on it. Only those trains retain this old segment/tree. */
  replaceWith(segments: readonly Railroad[]): void {
    this.replacementSegments = segments;
    for (const segment of segments) {
      segment.trips = this.trips;
      segment.lastTripTick = this.lastTripTick;
    }
  }

  isTraversable(): boolean {
    const pending: Railroad[] = [this];
    let visited = 0;
    while (pending.length) {
      if (++visited > 512) return false;
      const rail = pending.pop()!;
      if (rail.destroyed) return false;
      if (rail.replacementSegments) pending.push(...rail.replacementSegments);
      else if (rail.from.getRailroadTo(rail.to) !== rail) return false;
    }
    return true;
  }
  constructor(
    public from: TrainStation,
    public to: TrainStation,
    public tiles: TileRef[],
    public id: number,
  ) {}

  delete(game: Game) {
    this.destroyed = true;
    game.addUpdate({
      type: GameUpdateType.RailroadDestructionEvent,
      id: this.id,
    });
    this.from.removeRailroad(this);
    this.to.removeRailroad(this);
  }

  getClosestTileIndex(game: Game, to: TileRef): number {
    if (this.tiles.length === 0) return -1;
    const toX = game.x(to);
    const toY = game.y(to);
    let closestIndex = 0;
    let minDistSquared = Infinity;
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i];
      const dx = game.x(tile) - toX;
      const dy = game.y(tile) - toY;
      const distSquared = dx * dx + dy * dy;

      if (distSquared < minDistSquared) {
        minDistSquared = distSquared;
        closestIndex = i;
      }
    }
    return closestIndex;
  }
}

export function getOrientedRailroad(
  from: TrainStation,
  to: TrainStation,
): OrientedRailroad | null {
  const railroad = from.getRailroadTo(to);
  if (!railroad) return null;
  // If tiles are stored from -> to, we go forward when railroad.to === to
  const forward = railroad.to === to;
  return new OrientedRailroad(railroad, forward);
}

/**
 * Wrap a railroad with a direction so it always starts at tiles[0]
 */
export class OrientedRailroad {
  isCurrent(): boolean {
    return this.railroad.isTraversable();
  }
  recordTrip(tick: number): void {
    this.railroad.trips++;
    this.railroad.lastTripTick = tick;
  }
  private tiles: TileRef[] = [];
  constructor(
    private railroad: Railroad,
    private forward: boolean,
  ) {
    this.tiles = this.forward
      ? this.railroad.tiles
      : [...this.railroad.tiles].reverse();
  }

  getTiles(): TileRef[] {
    return this.tiles;
  }

  getStart(): TrainStation {
    return this.forward ? this.railroad.from : this.railroad.to;
  }

  getEnd(): TrainStation {
    return this.forward ? this.railroad.to : this.railroad.from;
  }
}
