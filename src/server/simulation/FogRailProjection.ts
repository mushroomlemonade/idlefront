import {
  GameUpdateType,
  type GameUpdateViewData,
  type RailroadConstructionUpdate,
} from "../../core/game/GameUpdates";
import type { NationFog } from "./GameFog";

interface Rail {
  tiles: number[];
  pages: Set<number>;
  segments: Map<string, RailroadConstructionUpdate>;
}
/** Only reclip tracks intersecting changed visibility pages, never every rail per tick. */
export class FogRailProjection {
  private readonly rails = new Map<number, Rail>();
  private readonly pages = new Map<number, Set<number>>();
  private nextPresentationID = -1;
  private global = false;

  project(
    source: GameUpdateViewData,
    fog: NationFog,
    output: GameUpdateViewData,
  ): void {
    const affected = new Set<number>();
    const removed = output.updates[GameUpdateType.RailroadDestructionEvent];
    const built = output.updates[GameUpdateType.RailroadConstructionEvent];
    const drop = (id: number) => {
      const rail = this.rails.get(id);
      if (!rail) return;
      for (const segment of rail.segments.values())
        removed.push({
          type: GameUpdateType.RailroadDestructionEvent,
          id: segment.id,
        });
      for (const page of rail.pages) {
        const ids = this.pages.get(page)!;
        ids.delete(id);
        if (!ids.size) this.pages.delete(page);
      }
      this.rails.delete(id);
    };
    const add = (id: number, tiles: number[]) => {
      drop(id);
      const pages = new Set(tiles.map((tile) => tile >>> 12));
      this.rails.set(id, { tiles, pages, segments: new Map() });
      for (const page of pages) {
        let ids = this.pages.get(page);
        if (!ids) this.pages.set(page, (ids = new Set()));
        ids.add(id);
      }
      affected.add(id);
    };
    for (const rail of source.updates[GameUpdateType.RailroadConstructionEvent])
      add(rail.id, rail.tiles);
    for (const rail of source.updates[GameUpdateType.RailroadSnapEvent]) {
      drop(rail.originalId);
      add(rail.newId1, rail.tiles1);
      add(rail.newId2, rail.tiles2);
    }
    for (const rail of source.updates[GameUpdateType.RailroadDestructionEvent])
      drop(rail.id);
    let previousPage = -1;
    for (const tile of fog.changedTiles) {
      const page = tile >>> 12;
      if (page === previousPage) continue;
      previousPage = page;
      for (const id of this.pages.get(page) ?? []) affected.add(id);
    }
    if (fog.global !== this.global)
      for (const id of this.rails.keys()) affected.add(id);
    this.global = fog.global;
    for (const id of affected) {
      const rail = this.rails.get(id);
      if (!rail) continue;
      const retained = new Map<string, RailroadConstructionUpdate>();
      let start = -1;
      for (let i = 0; i <= rail.tiles.length; i++) {
        if (i < rail.tiles.length && fog.isVisible(rail.tiles[i])) {
          if (start < 0) start = i;
          continue;
        }
        if (start < 0) continue;
        const key = `${start}:${i}`;
        let segment = rail.segments.get(key);
        if (!segment) {
          segment = {
            type: GameUpdateType.RailroadConstructionEvent,
            id: this.nextPresentationID--,
            tiles: rail.tiles.slice(start, i),
            revealed: true,
          };
          built.push(segment);
        }
        retained.set(key, segment);
        start = -1;
      }
      for (const [key, segment] of rail.segments)
        if (!retained.has(key))
          removed.push({
            type: GameUpdateType.RailroadDestructionEvent,
            id: segment.id,
          });
      rail.segments = retained;
    }
  }
}
