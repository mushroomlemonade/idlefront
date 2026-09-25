import { expect, it, vi } from "vitest";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { GameMapImpl } from "../../../src/core/game/GameMap";

it.each([false, true])(
  "preserves dequeue, combat and random order across stale queued targets (player=%s)",
  (targetIsPlayer) => {
    const terrain = new Uint8Array(25).fill(128);
    terrain[7] = 0;
    const map = new GameMapImpl(5, 5, terrain, 24);
    const targetSmallID = targetIsPlayer ? 2 : 0;
    [0, 7, 13].forEach((tile) => map.setOwnerID(tile, targetSmallID));
    map.setOwnerID(12, 1);
    map.setOwnerID(18, 3);
    const adjacency = vi.spyOn(map, "neighbors4");
    const queue = [12, 18, 0, 7, 13];
    const events: unknown[][] = [];
    const target = {
      isPlayer: () => targetIsPlayer,
      removeTroops: (troops: number) => events.push(["defender loss", troops]),
    };
    const owner = {
      isFriendly: () => false,
      conquer: (tile: number) => {
        events.push(["conquer", tile]);
        map.setOwnerID(tile, 1);
      },
    };
    const random = { nextInt: vi.fn(() => 2) };
    const config = {
      attackTilesPerTick: vi.fn(() => 1),
      attackLogic: vi.fn(() => ({
        attackerTroopLoss: 3,
        defenderTroopLoss: 5,
        tilesPerTickUsed: 1,
      })),
    };
    (AttackExecution.prototype as any).tick.call(
      {
        map,
        nbuf: [0, 0, 0, 0],
        ownerSmallID: 1,
        targetSmallID,
        target,
        _owner: owner,
        random,
        attack: {
          troops: () => 100,
          retreated: () => false,
          retreating: () => false,
          isActive: () => true,
          borderSize: () => 4,
          removeBorderTile: (tile: number) =>
            events.push(["remove border", tile]),
          setTroops: (troops: number) =>
            events.push(["attacker troops", troops]),
        },
        toConquer: { size: () => queue.length, dequeue: () => queue.shift()! },
        mg: { attackExpansionBudget: () => Infinity, config: () => config },
        addNeighbors: (tile: number) => events.push(["expand frontier", tile]),
        handleDeadDefender: () => events.push(["check death"]),
      },
      50,
    );
    expect(events).toEqual([
      ...[12, 18, 0, 7, 13].map((tile) => ["remove border", tile]),
      ["expand frontier", 13],
      ["attacker troops", 97],
      ...(targetIsPlayer ? [["defender loss", 5]] : []),
      ["conquer", 13],
      ["check death"],
    ]);
    // Adjacency is a pure read; its order/count is not part of gameplay.
    expect(adjacency).toHaveBeenCalled();
    expect(random.nextInt.mock.calls).toEqual([[0, 5]]);
    expect(config.attackLogic).toHaveBeenCalledOnce();
    expect(config.attackTilesPerTick.mock.calls[0]).toEqual([
      100,
      owner,
      target,
      6,
    ]);
    expect(queue).toEqual([]);
  },
);
