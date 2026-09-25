import type { Game, Unit } from "../../core/game/Game";

/** One shared incremental index per match, not one whole-fleet scan per viewer. */
export class VisibilityUnitIndex {
  private readonly pages = new Map<number, Set<number>>();
  private readonly unitPages = new Map<number, number>();
  private pending = new Set<number>();
  changed: ReadonlySet<number> = new Set();
  private readonly unsubscribe: () => void;
  constructor(game: Game) {
    for (const unit of game.units()) this.update(unit, false);
    this.unsubscribe = game.observeUnitLocations((unit, removed) =>
      this.update(unit, removed),
    );
  }
  private update(unit: Unit, removed: boolean): void {
    const id = unit.id(),
      previous = this.unitPages.get(id),
      page = unit.tile() >>> 12;
    if (previous !== undefined && (removed || previous !== page)) {
      const ids = this.pages.get(previous)!;
      ids.delete(id);
      if (!ids.size) this.pages.delete(previous);
      this.unitPages.delete(id);
    }
    if (!removed && previous !== page) {
      let ids = this.pages.get(page);
      if (!ids) this.pages.set(page, (ids = new Set()));
      ids.add(id);
      this.unitPages.set(id, page);
    }
    this.pending.add(id);
  }
  advance(): void {
    this.changed = this.pending;
    this.pending = new Set();
  }
  onPage(page: number): Iterable<number> {
    return this.pages.get(page) ?? [];
  }
  dispose(): void {
    this.unsubscribe();
  }
}
