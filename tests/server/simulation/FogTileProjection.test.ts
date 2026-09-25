import { expect, it } from "vitest";
import type { GameMap } from "../../../src/core/game/GameMap";
import { FOG_CHARTED, FOG_VISIBLE } from "../../../src/core/network/FogTileState";
import { DirtyFogTiles } from "../../../src/server/simulation/DirtyFogTiles";
import { fogExplorationSnapshot, projectFogTileRuns } from "../../../src/server/simulation/FogTileProjection";
import type { NationFog } from "../../../src/server/simulation/GameFog";
import { PlayerVisibility } from "../../../src/server/simulation/PlayerVisibility";

it("omits hidden simulation activity, clears newly hidden ownership, and agrees across devices", () => {
  const fog = { changedTiles: new Uint32Array([5]), isVisible: (t: number) => t === 2, isExplored: (t: number) => t === 5 } as unknown as NationFog;
  const map = { tileState: () => 7 } as unknown as GameMap;
  const input = new Uint32Array([2, 7, 99, 7]);
  const first = projectFogTileRuns(map, fog, input);
  expect(first).toEqual(new Uint32Array([2, 1, 7 | FOG_VISIBLE | FOG_CHARTED, 5, 1, FOG_CHARTED]));
  expect(projectFogTileRuns(map, fog, input)).toEqual(first);
});

it("rejoin snapshots contain charted terrain without hidden current ownership and bound expanded work", () => {
  const coverage = new PlayerVisibility(200000);
  coverage.setSource("old-journey", [[0, 150000]]);
  coverage.removeSource("old-journey");
  const fog = { coverage, isVisible: () => false } as unknown as NationFog;
  const packets = [...fogExplorationSnapshot({ tileState: () => 77 } as unknown as GameMap, fog)];
  expect(packets).toHaveLength(3);
  let total = 0;
  for (const packet of packets) {
    let expanded = 0;
    for (let i = 0; i < packet.length; i += 3) {
      expanded += packet[i + 1]; expect(packet[i + 2]).toBe(FOG_CHARTED);
    }
    expect(expanded).toBeLessThanOrEqual(65536); total += expanded;
  }
  expect(total).toBe(150000);
});

it("deduplicates sparse dirty tiles in deterministic order and resets", () => {
  const dirty = new DirtyFogTiles();
  for (const tile of [216000000, 0, 4095, 0, 4096, 4095]) dirty.add(tile);
  expect(dirty.drain()).toEqual(new Uint32Array([0, 4095, 4096, 216000000]));
  expect(dirty.drain()).toHaveLength(0);
});
