import { describe, expect, it } from "vitest";
import { PathFinderStepper } from "../../../src/core/pathfinding/PathFinderStepper";
import { TradeCorridorRouter } from "../../../src/core/pathfinding/transformers/TradeCorridorRouter";
import { PathStatus } from "../../../src/core/pathfinding/types";
import { tradeCorridorsForPreset } from "../../../src/core/TradeCorridors";

describe("shared trade geometry", () => {
  it("shares one immutable buffer while keeping cursors independent and public paths owned", () => {
    let revision = "1";
    const router = new TradeCorridorRouter(
      { findPath: () => [1, 2, 3, 4] },
      (a, b) => Math.abs(a - b),
      () => revision,
      () => 0,
      tradeCorridorsForPreset("longplay")!,
    );
    const shared = router.findSharedPath(1, 4);
    expect(router.findSharedPath(1, 4)).toBe(shared);
    const a = new PathFinderStepper(router),
      b = new PathFinderStepper(router);
    expect(a.next(1, 4)).toEqual({ status: PathStatus.NEXT, node: 2 });
    expect(a.next(2, 4)).toEqual({ status: PathStatus.NEXT, node: 3 });
    expect(b.next(1, 4)).toEqual({ status: PathStatus.NEXT, node: 2 });
    const copy = router.findPath(1, 4)!;
    copy[1] = 999;
    const tail = a.pathAfterNext()!;
    tail[0] = 999;
    expect(Array.from(shared!)).toEqual([1, 2, 3, 4]);
    revision = "2";
    expect(router.findSharedPath(1, 4)).not.toBe(shared);
    expect(b.next(2, 4)).toEqual({ status: PathStatus.NEXT, node: 3 });
  });
  it("lets active journeys retain evicted paths safely", () => {
    const router = new TradeCorridorRouter(
      { findPath: (a, b) => [Number(a), b] },
      (a, b) => Math.abs(a - b),
      () => "1",
      () => 0,
      tradeCorridorsForPreset("longplay")!,
      10,
      1,
    );
    const first = router.findSharedPath(1, 2)!;
    router.findSharedPath(3, 4);
    expect(Array.from(first)).toEqual([1, 2]);
    expect(router.findSharedPath(1, 2)).not.toBe(first);
  });
});
