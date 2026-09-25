import { expect, it, vi } from "vitest";
import { AStarWaterHierarchical } from "../src/core/pathfinding/algorithms/AStar.WaterHierarchical";
it("caches identical lookups while a replacement graph gets fresh results", () => {
  const map = {
    width: () => 10,
    height: () => 10,
    x: (t: number) => t % 10,
    y: (t: number) => Math.floor(t / 10),
  };
  const node = { id: 1, x: 0, y: 0 };
  const graph = {
    clusterSize: 4,
    nodeCount: 2,
    getCluster: vi.fn(() => ({ nodeIds: [1] })),
    getNode: () => node,
  };
  const finder = new AStarWaterHierarchical(map as never, graph as never);
  const resolver = (finder as any).sourceResolver;
  expect(resolver.resolveTarget(2)).toBe(node);
  expect(resolver.resolveTarget(2)).toBe(node);
  expect(graph.getCluster).toHaveBeenCalledTimes(1);
  const replacement = { ...graph, getCluster: () => ({ nodeIds: [] }) };
  const rebuilt = new AStarWaterHierarchical(
    map as never,
    replacement as never,
  );
  expect((rebuilt as any).sourceResolver.resolveTarget(2)).toBeNull();
});
