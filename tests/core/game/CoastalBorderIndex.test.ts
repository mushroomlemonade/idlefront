import { CoastalBorderIndex } from "../../../src/core/game/CoastalBorderIndex";
import { PlayerType } from "../../../src/core/game/Game";
import { playerInfo, setup } from "../../util/Setup";

describe("incremental coastline candidates", () => {
  it("matches ordered border scans through captures, relinquishing and terrain edits", async () => {
    const game = await setup("plains", {}, [
      playerInfo("a", PlayerType.Human),
      playerInfo("b", PlayerType.Nation),
    ]);
    const [a, b] = [game.player("a"), game.player("b")];
    const map = game.map();
    for (let x = 4; x < 16; x++)
      for (let y = 4; y < 16; y++) {
        const tile = game.ref(x, y);
        if ((x + y) % 3 === 0) map.setShorelineBit(tile);
        a.conquer(tile);
      }
    const index = new CoastalBorderIndex(game);
    const check = () => {
      for (const player of [a, b])
        expect(index.tiles(player)).toEqual(
          Array.from(player.borderTiles()).filter((tile) => map.isShore(tile)),
        );
    };
    check();
    let seed = 7;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 1000; step++) {
      const tile = game.ref(4 + (random() % 12), 4 + (random() % 12));
      switch (random() % 4) {
        case 0:
          (random() % 2 ? a : b).conquer(tile);
          break;
        case 1: {
          const owner = game.owner(tile);
          if (owner.isPlayer()) owner.relinquish(tile);
          break;
        }
        case 2:
          map.setShorelineBit(tile);
          break;
        case 3:
          map.clearShorelineBit(tile);
          break;
      }
      check();
    }
    // Water conversions remove candidates even if the tile's old border
    // entry has not yet been repaired by the engine's water-change callback.
    const tile = a.tiles().values().next().value!;
    map.setShorelineBit(tile);
    check();
    map.setWater(tile);
    check();
  });

  it("does not enumerate a nation's inland territory/borders again after seeding", async () => {
    const game = await setup("plains", {}, [
      playerInfo("a", PlayerType.Nation),
    ]);
    const a = game.player("a");
    a.conquer(game.ref(8, 8));
    game.map().setShorelineBit(game.ref(8, 8));
    const index = new CoastalBorderIndex(game);
    expect(index.tiles(a)).toEqual([game.ref(8, 8)]);
    const borders = a.borderTiles();
    const iterator = vi
      .spyOn(borders, Symbol.iterator)
      .mockImplementation(() => {
        throw new Error("full border scan");
      });
    const tiles = vi.spyOn(a, "tiles").mockImplementation(() => {
      throw new Error("full territory scan");
    });
    a.conquer(game.ref(9, 8));
    game.map().setShorelineBit(game.ref(9, 8));
    expect(index.tiles(a)).toEqual([game.ref(8, 8), game.ref(9, 8)]);
    iterator.mockRestore();
    tiles.mockRestore();
  });
});
