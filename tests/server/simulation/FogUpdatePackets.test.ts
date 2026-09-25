import { expect, it } from "vitest";
import { decodeViewPacket } from "../../../src/core/network/ViewProtocol";
import {
  encodeFogUpdate,
  FOG_TILE_PACKET_BUDGET,
} from "../../../src/server/simulation/FogUpdatePackets";
import { emptyView } from "../../../src/server/simulation/ViewSnapshot";

it("splits large reveals into bounded work without dropping runs or completing a tick early", () => {
  const update = emptyView(42);
  update.packedTileRuns = new Uint32Array([7, 200000, 0x9001]);
  update.packedTerrainUpdates = new Uint32Array(140000);
  const packets = encodeFogUpdate(update).map((bytes) =>
    decodeViewPacket(bytes.buffer),
  );
  let count = 0,
    terrain = 0;
  for (const [index, packet] of packets.entries()) {
    if (packet.kind !== "update") throw new Error("Wrong packet kind");
    let work = (packet.update.packedTerrainUpdates?.length ?? 0) / 2;
    terrain += work;
    const runs = packet.update.packedTileRuns ?? [];
    for (let i = 1; i < runs.length; i += 3) {
      work += runs[i];
      count += runs[i];
    }
    expect(work).toBeLessThanOrEqual(FOG_TILE_PACKET_BUDGET);
    expect(packet.update.tick).toBe(42);
    expect(packet.snapshot).toBe(
      index === 0 ? "begin" : index === packets.length - 1 ? "end" : "part",
    );
  }
  expect(count).toBe(200000);
  expect(terrain).toBe(70000);
});
