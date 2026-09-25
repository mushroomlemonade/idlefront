import { GameMapImpl, type GameMap } from "../../../src/core/game/GameMap";
import { PagedGameMap } from "../../../src/core/game/PagedGameMap";
import { WaterManager } from "../../../src/core/game/WaterManager";

describe.each([false, true])("water component memo paged=%s", (paged) => {
  const createMap = (width: number, height: number): GameMap => {
    const terrain = new Uint8Array(width * height).fill(128);
    for (let y = 0; y < height; y++) terrain[y * width + 2] = 0;
    return paged
      ? PagedGameMap.fromRowMajor(
          width,
          height,
          16,
          terrain,
          width * height - height,
        )
      : new GameMapImpl(width, height, terrain, width * height - height);
  };

  it("matches uncached queries through terrain edits and water graph rebuilds", () => {
    const full = createMap(64, 64),
      mini = createMap(32, 32);
    const manager = new WaterManager(full, mini, false);
    const exact = (manager as any).getWaterComponentUncached.bind(manager);
    for (let round = 0; round < 30; round++) {
      manager.queueTile(full.ref(3 + round, 3));
      manager.tick((round + 1) * 20);
      // Covers minimap terrain edits before the throttled graph rebuild too.
      mini.setShorelineBit(mini.ref(4 + (round % 20), 4));
      for (let tile = 0; tile < 4096; tile += 7) {
        expect(manager.getWaterComponent(tile)).toBe(exact(tile));
        expect(manager.getWaterComponent(tile)).toBe(exact(tile));
      }
    }
    expect(manager.waterGraphVersion()).toBeGreaterThan(0);
  });

  it("reuses hits and misses, invalidating null entries on minimap edits", () => {
    const full = createMap(64, 64),
      mini = createMap(32, 32);
    const manager = new WaterManager(full, mini, false);
    const query = vi.spyOn(manager as any, "getWaterComponentUncached");
    const tile = full.ref(60, 60);
    expect(manager.getWaterComponent(tile)).toBeNull();
    expect(manager.getWaterComponent(tile)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    mini.setWater(mini.ref(30, 30));
    manager.getWaterComponent(tile);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("caps memo storage instead of growing with every queried world tile", () => {
    const full = createMap(512, 256),
      mini = createMap(256, 128);
    const manager = new WaterManager(full, mini, false);
    const exact = (manager as any).getWaterComponentUncached.bind(manager);
    for (let tile = 0; tile < 66000; tile++) manager.getWaterComponent(tile);
    expect((manager as any).componentMemo.size).toBeLessThanOrEqual(65536);
    for (const tile of [0, 4, 65535, 65536, 65999])
      expect(manager.getWaterComponent(tile)).toBe(exact(tile));
  });
});
