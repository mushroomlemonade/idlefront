import { Structures, type Unit, type UnitType } from "../../core/game/Game";
import type { UnitUpdate } from "../../core/game/GameUpdates";

export function isPositionDynamic(type: UnitType): boolean {
  return !Structures.has(type);
}

interface UnitLookup {
  units(): Unit[];
  unit(id: number): Unit | undefined;
}

/**
 * Adds authoritative position updates without scanning stationary structures
 * every tick. The first call intentionally reproduces the old full-unit sync;
 * subsequent calls visit only mobile units and unit lifecycle deltas.
 */
export class MovingUnitTracker {
  private initialized = false;
  private readonly positions = new Map<number, number>();

  appendChangedPositions(game: UnitLookup, updates: UnitUpdate[]): void {
    if (!this.initialized) {
      for (const unit of game.units()) {
        updates.push(unit.toUpdate());
        if (isPositionDynamic(unit.type())) {
          this.positions.set(unit.id(), unit.tile());
        }
      }
      this.initialized = true;
      return;
    }

    // Learn about births/deaths from the ordinary update stream. New mobile
    // units use a sentinel so their final post-execution position is appended
    // once, matching the old behavior.
    for (const update of updates) {
      if (!isPositionDynamic(update.unitType)) continue;
      if (!update.isActive) this.positions.delete(update.id);
      else if (!this.positions.has(update.id)) this.positions.set(update.id, -1);
    }

    for (const [id, previous] of this.positions) {
      const unit = game.unit(id);
      if (!unit || !unit.isActive()) {
        this.positions.delete(id);
        continue;
      }
      const position = unit.tile();
      if (previous === position) continue;
      this.positions.set(id, position);
      updates.push(unit.toUpdate());
    }
  }

  trackedCount(): number {
    return this.positions.size;
  }
}
