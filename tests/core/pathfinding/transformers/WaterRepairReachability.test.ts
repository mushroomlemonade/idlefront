import { expect, it } from "vitest";
import { GameMapImpl } from "../../../../src/core/game/GameMap";
import { WaterRepairSearch } from "../../../../src/core/pathfinding/algorithms/WaterRepairSearch";
import { WaterRefinementTransformer } from "../../../../src/core/pathfinding/transformers/WaterRefinementTransformer";

it("reuses global component proofs across changed origins but invalidates on terrain conversion", () => {
  const { map, terrain, corridor, blocksWide } = fixture();
  for (let y = 0; y < 128; y++) terrain[y * 256 + 230] = 128;
  let revision = 0;
  const search = new WaterRepairSearch(map, true, () => String(revision));
  const baseline = new WaterRepairSearch(map, false);
  const to = 256 * 64 + 240;
  expect(search.search([0], to, corridor, blocksWide)).toBeNull();
  const expanded = search.metrics.expanded;
  expect(search.search([256], to, corridor, blocksWide)).toBeNull();
  expect(search.metrics.connectivityHits).toBe(1);
  expect(search.metrics.expanded).toBe(expanded);
  expect(search.search([512], to + 1, corridor, blocksWide)).toBeNull();
  expect(search.metrics.connectivityHits).toBe(2);
  // Dry shoreline starts adjacent to the isolated basin remain valid.
  const shore = 256 * 64 + 230;
  expect(search.search([shore], to, corridor, blocksWide)).toEqual(
    baseline.search([shore], to, corridor, blocksWide),
  );
  map.setWater(shore);
  revision++;
  expect(search.search([0], to, corridor, blocksWide)).toEqual(
    baseline.search([0], to, corridor, blocksWide),
  );
  expect(search.metrics.connectivityHits).toBe(2);
});

it("does not cache a component disconnected only by its query corridor", () => {
  const { map, terrain, corridor, blocksWide } = fixture();
  for (let y = 0; y < 112; y++) terrain[y * 256 + 230] = 128;
  const limited = new Set(
    [...corridor].filter((b) => Math.floor(b / blocksWide) < 7),
  );
  const search = new WaterRepairSearch(map, true, () => "stable");
  const baseline = new WaterRepairSearch(map, false),
    to = 256 * 64 + 240;
  expect(search.search([0], to, limited, blocksWide)).toBeNull();
  expect(search.search([0], to, corridor, blocksWide)).toEqual(
    baseline.search([0], to, corridor, blocksWide),
  );
  expect(search.metrics.connectivityHits).toBe(0);
});

function fixture(width = 256, height = 128) {
  const terrain = new Uint8Array(width * height).fill(32);
  const map = new GameMapImpl(width, height, terrain, 0);
  const blocksWide = Math.ceil(width / 16);
  const corridor = new Set(
    Array.from({ length: blocksWide * Math.ceil(height / 16) }, (_, i) => i),
  );
  return { map, terrain, corridor, blocksWide };
}

it("learns a fully exhausted small source and reuses it for new destinations in both directions", () => {
  const { map, terrain, corridor, blocksWide } = fixture();
  for (let y = 0; y < 128; y++) terrain[y * 256 + 8] = 128;
  let revision = "0";
  const search = new WaterRepairSearch(map, true, () => revision);
  expect(search.search([0], 240, corridor, blocksWide)).toBeNull();
  const expanded = search.metrics.expanded;
  expect(expanded).toBe(1024);
  expect(search.search([256], 241, corridor, blocksWide)).toBeNull();
  expect(search.search([242], 512, corridor, blocksWide)).toBeNull();
  expect(search.metrics.expanded).toBe(expanded);
  expect(search.provenDisconnected([0, 240], 241)).toBe(false);
  expect(search.provenDisconnected([0], 8)).toBe(false);
  map.setWater(8);
  revision = "1";
  expect(search.search([0], 240, corridor, blocksWide)).not.toBeNull();
});

it("rejects learned impossibility before coarse route calculation", () => {
  const { map, terrain } = fixture();
  for (let y = 0; y < 128; y++) terrain[y * 256 + 8] = 128;
  let calls = 0;
  const refine = new WaterRefinementTransformer(
    {
      findPath: () => {
        calls++;
        return [0, 240];
      },
    },
    map,
    () => "0",
  );
  // Supply a corridor covering the complete small origin component.
  const route = Array.from({ length: 128 }, (_, y) => y * 256);
  expect(refine.refine([...route, 240], 0, 240)).toBeNull();
  expect(refine.findPath(256, 241)).toBeNull();
  expect(refine.coarsePath(512, 242)).toBeNull();
  expect(calls).toBe(0);
});

it("does not infer global disconnection from a small corridor-limited search", () => {
  const { map } = fixture();
  const search = new WaterRepairSearch(map, true, () => "0");
  expect(search.search([0], 240, new Set([0]), 16)).toBeNull();
  expect(search.provenDisconnected([0], 241)).toBe(false);
});

it("proves a disconnected destination without exhausting the large origin component", () => {
  const { map, terrain, corridor, blocksWide } = fixture();
  const destination = 256 * 64 + 240;
  for (let y = 0; y < 128; y++) terrain[y * 256 + 230] = 128;
  const baseline = new WaterRepairSearch(map, false);
  const candidate = new WaterRepairSearch(map);
  expect(candidate.search([0], destination, corridor, blocksWide)).toEqual(
    baseline.search([0], destination, corridor, blocksWide),
  );
  expect(candidate.metrics.rejected).toBe(1);
  expect(candidate.metrics.expanded).toBe(4096);
  expect(baseline.metrics.expanded).toBeGreaterThan(20000);
  // No cached unreachable result survives terrain changes.
  map.setWater(64 * 256 + 230);
  expect(candidate.search([0], destination, corridor, blocksWide)).toEqual(
    baseline.search([0], destination, corridor, blocksWide),
  );
});

it("falls back at the reachability budget, preserving exact routes and original cutoff", () => {
  const { map, corridor, blocksWide } = fixture(512, 512);
  const baseline = new WaterRepairSearch(map, false);
  const candidate = new WaterRepairSearch(map, true, () => "0");
  expect(candidate.search([0], 512 * 512 - 1, corridor, blocksWide)).toEqual(
    baseline.search([0], 512 * 512 - 1, corridor, blocksWide),
  );
  expect(candidate.metrics.reachabilityVisited).toBeLessThanOrEqual(8192);
  expect(candidate.provenDisconnected([0], 512 * 512 - 1)).toBe(false);
});

it("cached proofs agree with native reachability across changing endpoints and terrain", () => {
  const { map, terrain, corridor, blocksWide } = fixture(32, 32);
  for (let y = 0; y < 32; y++) terrain[y * 32 + 8] = 128;
  let revision = 0;
  const candidate = new WaterRepairSearch(map, true, () => String(revision));
  const baseline = new WaterRepairSearch(map, false);
  for (let i = 0; i < 180; i++) {
    if (i === 90) {
      map.setWater(16 * 32 + 8);
      revision++;
    }
    const from = (i * 193) % 1024,
      to = (i * 97 + 29) % 1024;
    const starts = i % 5 === 0 ? [from, (from + 23) % 1024] : [from];
    expect(candidate.search(starts, to, corridor, blocksWide)).toEqual(
      baseline.search(starts, to, corridor, blocksWide),
    );
  }
});

it("does no reverse work for short routes and supports empty/duplicate/dry/outside-corridor sources", () => {
  const { map, terrain, corridor, blocksWide } = fixture();
  terrain[0] = 128;
  terrain[2] = 128;
  const baseline = new WaterRepairSearch(map, false);
  const candidate = new WaterRepairSearch(map);
  for (const sources of [[], [0], [0, 0, 1], [2], [3, 0]]) {
    expect(candidate.search(sources, 2, corridor, blocksWide)).toEqual(
      baseline.search(sources, 2, corridor, blocksWide),
    );
  }
  expect(candidate.metrics.reachabilityVisited).toBe(0);
  corridor.delete(0);
  expect(candidate.search([15, 15], 32767, corridor, blocksWide)).toEqual(
    baseline.search([15, 15], 32767, corridor, blocksWide),
  );
});
