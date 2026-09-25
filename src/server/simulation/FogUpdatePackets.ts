import type { GameUpdateViewData } from "../../core/game/GameUpdates";
import { encodeViewPacket } from "../../core/network/ViewProtocol";
import { emptyView } from "./ViewSnapshot";

export const FOG_TILE_PACKET_BUDGET = 65_536;
/** Large diplomacy/industrial reveals yield between bounded client tile writes. */
export function encodeFogUpdate(
  update: GameUpdateViewData,
): Uint8Array<ArrayBuffer>[] {
  const runs = update.packedTileRuns;
  let tiles = (update.packedTerrainUpdates?.length ?? 0) / 2;
  if (runs) for (let i = 1; i < runs.length; i += 3) tiles += runs[i];
  if (tiles <= FOG_TILE_PACKET_BUDGET)
    return [encodeViewPacket({ kind: "update", update })];
  const begin = {
    ...update,
    packedTileRuns: undefined,
    packedTerrainUpdates: undefined,
    pendingTurns: 2,
  };
  const packets = [
    encodeViewPacket({ kind: "update", snapshot: "begin", update: begin }),
  ];
  let part = emptyView(update.tick),
    chunk: number[] = [],
    work = 0;
  const flush = () => {
    if (!work) return;
    part.packedTileRuns = Uint32Array.from(chunk);
    part.pendingTurns = 2;
    packets.push(
      encodeViewPacket({ kind: "update", snapshot: "part", update: part }),
    );
    part = emptyView(update.tick);
    chunk = [];
    work = 0;
  };
  if (runs)
    for (let i = 0; i < runs.length; i += 3) {
      let tile = runs[i],
        remaining = runs[i + 1];
      while (remaining) {
        const take = Math.min(remaining, FOG_TILE_PACKET_BUDGET - work);
        chunk.push(tile, take, runs[i + 2]);
        work += take;
        tile += take;
        remaining -= take;
        if (work === FOG_TILE_PACKET_BUDGET) flush();
      }
    }
  flush();
  const terrain = update.packedTerrainUpdates;
  if (terrain)
    for (let i = 0; i < terrain.length; i += FOG_TILE_PACKET_BUDGET * 2) {
      const part = emptyView(update.tick);
      part.pendingTurns = 2;
      part.packedTerrainUpdates = terrain.subarray(
        i,
        i + FOG_TILE_PACKET_BUDGET * 2,
      );
      packets.push(
        encodeViewPacket({ kind: "update", snapshot: "part", update: part }),
      );
    }
  const end = emptyView(update.tick);
  end.fog = update.fog;
  packets.push(
    encodeViewPacket({ kind: "update", snapshot: "end", update: end }),
  );
  return packets;
}
