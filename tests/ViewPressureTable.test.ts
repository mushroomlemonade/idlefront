import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import { usesWideOwnerStorage } from "../src/core/game/OwnerIdCodec";
import {
  packPressureTable,
  unpackPressureTable,
} from "../src/core/network/ViewPressureTable";
import {
  decodeViewPacket,
  encodeViewPacket,
  type ViewPacket,
} from "../src/core/network/ViewProtocol";
import { emptyView } from "../src/server/simulation/ViewSnapshot";

function fixture(count: number): ViewPacket {
  const update = emptyView(400);
  update.updates[GameUpdateType.Player] = Array.from(
    { length: count },
    (_, i) => ({
      type: GameUpdateType.Player,
      id: `nation-${i}`,
      pressure: {
        civilians: 1000 + i,
        military: 500 + i,
        target: 0.5,
        effectiveTarget: 0.5,
        growthPerSecond: i * 0.123456789,
        automatic: true,
        autoDefenceEnabled: false,
        explicitIdle: false,
      },
    }),
  );
  return { kind: "update", update };
}

describe("compact pressure transport", () => {
  it("round-trips without changing inputs, numbers, or other player fields", () => {
    const packet = fixture(3000),
      original = fixture(3000);
    const compact = encodeViewPacket(packet);
    expect(decodeViewPacket(compact.buffer)).toEqual(original);
    expect(packet).toEqual(original);
    const legacy = encodeViewPacket(packet, false);
    expect(decodeViewPacket(legacy.buffer)).toEqual(original);
    expect(compact.length).toBeLessThan(legacy.length * 0.4);
    expect(deflateRawSync(compact).length).toBeLessThan(
      deflateRawSync(legacy).length,
    );
  });
  it("preserves omitted versus explicitly undefined optional fields and unknown future fields", () => {
    const packet = fixture(3);
    if (packet.kind !== "update") throw new Error();
    const players = packet.update.updates[GameUpdateType.Player];
    delete players[0].pressure!.growthPerSecond;
    players[1].pressure!.growthPerSecond = undefined;
    players[1].pressure!.autoDefenceEnabled = undefined;
    Object.assign(players[2].pressure!, { future: "must survive" });
    const decoded = decodeViewPacket(encodeViewPacket(packet).buffer);
    expect(decoded).toStrictEqual(packet);
    if (decoded.kind !== "update") throw new Error();
    expect(
      Object.prototype.hasOwnProperty.call(
        decoded.update.updates[GameUpdateType.Player][0].pressure!,
        "growthPerSecond",
      ),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(
        decoded.update.updates[GameUpdateType.Player][1].pressure!,
        "growthPerSecond",
      ),
    ).toBe(true);
  });
  it("rejects malformed tables rather than changing another player's state", () => {
    const table = packPressureTable(fixture(2)) as any;
    table.indices[2] = table.indices[0];
    expect(() => unpackPressureTable(table)).toThrow();
    const bad = packPressureTable(fixture(1)) as any;
    bad.values = new Float64Array(0);
    expect(() => unpackPressureTable(bad)).toThrow();
  });
  it("keeps 3000-bot rosters in small storage, preserving existing 16000-bot replay allocation", () => {
    expect(
      usesWideOwnerStorage({
        bots: 3000,
        maxPlayers: 16,
        longplayStressTest: "owner16-v1",
      }),
    ).toBe(false);
    expect(
      usesWideOwnerStorage({
        bots: 16000,
        maxPlayers: 16,
        longplayStressTest: "owner16-v1",
      }),
    ).toBe(true);
    expect(
      usesWideOwnerStorage({
        bots: 3695,
        maxPlayers: 16,
        longplayStressTest: "owner16-v1",
      }),
    ).toBe(true);
    expect(usesWideOwnerStorage({ bots: 2000 })).toBe(false);
  });
});
