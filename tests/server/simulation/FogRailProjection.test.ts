import { expect, it, vi } from "vitest";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import { FogRailProjection } from "../../../src/server/simulation/FogRailProjection";
import type { NationFog } from "../../../src/server/simulation/GameFog";
import { emptyView } from "../../../src/server/simulation/ViewSnapshot";

it("reveals only contiguous visible rail segments, then removes lost sight without disclosing hidden connections", () => {
  const projector = new FogRailProjection();
  const visible = new Set([1, 2, 5]);
  const fog = {
    changedTiles: new Uint32Array(),
    global: false,
    isVisible: vi.fn((t: number) => visible.has(t)),
  } as unknown as NationFog;
  const source = emptyView(1);
  source.updates[GameUpdateType.RailroadConstructionEvent] = [
    {
      type: GameUpdateType.RailroadConstructionEvent,
      id: 1,
      tiles: [1, 2, 3, 4, 5, 6],
    },
  ];
  const out = emptyView(1);
  projector.project(source, fog, out);
  expect(
    out.updates[GameUpdateType.RailroadConstructionEvent].map((r) => r.tiles),
  ).toEqual([[1, 2], [5]]);
  const calls = vi.mocked(fog.isVisible).mock.calls.length;
  projector.project(emptyView(2), fog, emptyView(2));
  expect(vi.mocked(fog.isVisible).mock.calls.length).toBe(calls);
  visible.clear();
  visible.add(5);
  fog.changedTiles = new Uint32Array([1, 2]);
  const lost = emptyView(3);
  projector.project(emptyView(3), fog, lost);
  expect(lost.updates[GameUpdateType.RailroadConstructionEvent]).toHaveLength(
    0,
  );
  expect(
    lost.updates[GameUpdateType.RailroadDestructionEvent].map((r) => r.id),
  ).toEqual([out.updates[GameUpdateType.RailroadConstructionEvent][0].id]);
});

it("reveals existing track immediately as scouts advance rather than replaying construction", () => {
  const projector = new FogRailProjection();
  const visible = new Set<number>();
  const fog = {
    changedTiles: new Uint32Array(),
    global: false,
    isVisible: (t: number) => visible.has(t),
  } as unknown as NationFog;
  const source = emptyView(1);
  source.updates[GameUpdateType.RailroadConstructionEvent] = [
    {
      type: GameUpdateType.RailroadConstructionEvent,
      id: 3,
      tiles: [9, 10, 11],
    },
  ];
  const hidden = emptyView(1);
  projector.project(source, fog, hidden);
  expect(hidden.updates[GameUpdateType.RailroadConstructionEvent]).toHaveLength(
    0,
  );
  visible.add(10);
  visible.add(11);
  fog.changedTiles = new Uint32Array([10, 11]);
  const out = emptyView(2);
  projector.project(emptyView(2), fog, out);
  expect(
    out.updates[GameUpdateType.RailroadConstructionEvent][0],
  ).toMatchObject({ tiles: [10, 11], revealed: true });
});
