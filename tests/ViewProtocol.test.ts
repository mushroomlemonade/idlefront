import { describe, expect, it } from "vitest";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import {
  decodeViewPacket,
  encodeViewPacket,
} from "../src/core/network/ViewProtocol";
import { emptyView } from "../src/server/simulation/ViewSnapshot";

describe("authoritative view codec", () => {
  it("round-trips packed buffers, bigint, Sets, and explicit diff clears", () => {
    const update = emptyView(22);
    update.packedTileUpdates = new Uint32Array([7, 0xffffffff, 18, 31]);
    update.packedPlayerUpdates = new Float64Array([
      1, 3, 9007199254740991, 1.25,
    ]);
    update.updates[GameUpdateType.Player] = [
      {
        type: GameUpdateType.Player,
        id: "player",
        spawnTile: undefined,
        gold: 15n,
        embargoes: new Set(["other"]),
      },
    ];
    const decoded = decodeViewPacket(
      encodeViewPacket({ kind: "update", update }).buffer,
    );
    expect(decoded).toEqual({ kind: "update", update });
    if (decoded.kind !== "update") throw new Error("Wrong packet");
    expect(
      Object.prototype.hasOwnProperty.call(
        decoded.update.updates[GameUpdateType.Player][0],
        "spawnTile",
      ),
    ).toBe(true);
  });
  it("rejects truncated or wrong-version envelopes", () => {
    expect(() => decodeViewPacket(new ArrayBuffer(0))).toThrow();
    const bytes = encodeViewPacket({ kind: "update", update: emptyView(0) });
    expect(() => decodeViewPacket(bytes.buffer.slice(0, 14))).toThrow();
    bytes[0] = 0;
    expect(() => decodeViewPacket(bytes.buffer)).toThrow();
  });
});
