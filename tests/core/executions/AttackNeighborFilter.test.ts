import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { GameMapImpl } from "../../../src/core/game/GameMap";

it("preserves eligible neighbor and random-draw order around owned tiles and water", () => {
  const terrain = new Uint8Array(9).fill(128);
  terrain[7] = 128 | 12; // Highland, south.
  terrain[3] = 0; // Water, west: still not attackable wilderness.
  terrain[5] = 128 | 20; // Mountain, east.
  const map = new GameMapImpl(3, 3, terrain, 8);
  map.setOwnerID(4, 1);
  map.setOwnerID(1, 1);
  const addBorderTile = vi.fn(),
    enqueue = vi.fn();
  const nextInt = vi.fn().mockReturnValueOnce(2).mockReturnValueOnce(4);
  (AttackExecution.prototype as any).addNeighbors.call(
    {
      attack: { addBorderTile },
      mg: { ticks: () => 10 },
      map,
      ownerSmallID: 1,
      targetSmallID: 0,
      nbuf: [0, 0, 0, 0],
      nbuf2: [0, 0, 0, 0],
      random: { nextInt },
      toConquer: { enqueue },
    },
    4,
  );
  expect(addBorderTile.mock.calls).toEqual([[7], [5]]);
  expect(nextInt.mock.calls).toEqual([
    [0, 7],
    [0, 7],
  ]);
  expect(enqueue.mock.calls).toEqual([
    [7, 25],
    [5, 31],
  ]);
});
