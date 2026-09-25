import { describe, expect, it } from "vitest";
import { RemoteViewIdentity } from "../../src/client/RemoteViewIdentity";
import type { GameStartInfo } from "../../src/core/Schemas";
import { MessageType } from "../../src/core/game/Game";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import { anonymousSimulationName } from "../../src/core/network/ViewIdentity";
import { emptyView } from "../../src/server/simulation/ViewSnapshot";

const start = {
  config: { anonymizeNames: true },
  players: [
    { clientID: "self0001", username: "a", clanTag: null },
    { clientID: "enemy001", username: "Hidden Player", clanTag: null },
  ],
} as GameStartInfo;

describe("permitted identities in shared server views", () => {
  it("uses only the authorized roster, with no substring replacement of ordinary words", () => {
    const identity = new RemoteViewIdentity(start);
    const update = emptyView(1);
    update.updates[GameUpdateType.Player] = [
      {
        type: GameUpdateType.Player,
        id: "p1",
        clientID: "enemy001",
        name: anonymousSimulationName(1),
        clanTag: null,
      },
    ];
    update.updates[GameUpdateType.DisplayEvent] = [
      {
        type: GameUpdateType.DisplayEvent,
        message: `a naval attack from ${anonymousSimulationName(1)}`,
        messageType: MessageType.NAVAL_INVASION_INBOUND,
        playerID: null,
        params: { name: anonymousSimulationName(0), count: 4 },
      },
    ];
    update.updates[GameUpdateType.UnitIncoming] = [
      {
        type: GameUpdateType.UnitIncoming,
        message: `${anonymousSimulationName(1)} - atom bomb inbound`,
        messageType: MessageType.NUKE_INBOUND,
        unitID: 1,
        playerID: 1,
      },
    ];
    identity.apply(update);
    expect(update.updates[GameUpdateType.Player][0]).toMatchObject({
      name: "Hidden Player",
      displayName: "Hidden Player",
      clanTag: null,
    });
    expect(update.updates[GameUpdateType.DisplayEvent][0]).toMatchObject({
      message: "a naval attack from Hidden Player",
      params: { name: "a", count: 4 },
    });
    expect(update.updates[GameUpdateType.UnitIncoming][0].message).toBe(
      "Hidden Player - atom bomb inbound",
    );
  });

  it("fits each viewer's label using server geometry, including later placement-only frames", () => {
    const identity = new RemoteViewIdentity(start);
    const initial = emptyView(1);
    initial.updates[GameUpdateType.Player] = [
      { type: GameUpdateType.Player, id: "p1", clientID: "enemy001" },
    ];
    identity.apply(initial);
    const later = emptyView(30);
    later.playerNameViewData = {
      p1: {
        x: 10,
        y: 20,
        size: 99,
        bounds: { width: 12, height: 30, centerY: 20 },
      },
    };
    identity.apply(later);
    expect(later.playerNameViewData.p1.size).toBe(24 / "Hidden Player".length);
    expect(later.playerNameViewData.p1.y).toBe(
      Math.ceil(20 - 24 / "Hidden Player".length / 3),
    );
  });

  it("does not touch bot names, typed map buffers, or ordinary unrecognized tokens", () => {
    const identity = new RemoteViewIdentity(start);
    const update = emptyView(1);
    const tiles = new Uint32Array([3, 4]);
    update.packedTileUpdates = tiles;
    update.updates[GameUpdateType.Player] = [
      { type: GameUpdateType.Player, id: "bot", clientID: null, name: "a" },
    ];
    identity.apply(update);
    expect(update.packedTileUpdates).toBe(tiles);
    expect(update.updates[GameUpdateType.Player][0].name).toBe("a");
  });

  it("keeps the same anonymous stream but renders different granted identities for each viewer", () => {
    const stream = emptyView(1);
    stream.updates[GameUpdateType.Player] = [
      {
        type: GameUpdateType.Player,
        id: "p1",
        clientID: "enemy001",
        name: anonymousSimulationName(1),
      },
    ];
    const normal = structuredClone(stream);
    const granted = structuredClone(stream);
    new RemoteViewIdentity(start).apply(normal);
    new RemoteViewIdentity({
      ...start,
      players: [
        start.players[0],
        { ...start.players[1], username: "Real Name", clanTag: "ADM" },
      ],
    }).apply(granted);
    expect(normal.updates[GameUpdateType.Player][0].displayName).toBe(
      "Hidden Player",
    );
    expect(granted.updates[GameUpdateType.Player][0].displayName).toBe(
      "[ADM] Real Name",
    );
    expect(stream.updates[GameUpdateType.Player][0].name).toBe(
      anonymousSimulationName(1),
    );
  });
});
