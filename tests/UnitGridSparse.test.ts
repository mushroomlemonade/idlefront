import { expect, it } from "vitest";
import { type Unit, UnitType } from "../src/core/game/Game";
import { type GameMap } from "../src/core/game/GameMap";
import { UnitGrid } from "../src/core/game/UnitGrid";
import { ReferenceUnitGrid } from "./util/ReferenceUnitGrid";

export function spatialFixture() {
  const width = 12324,
    height = 5844;
  const map = {
    width: () => width,
    height: () => height,
    x: (t: number) => t % width,
    y: (t: number) => Math.floor(t / width),
  } as GameMap;
  const candidate = new UnitGrid(map),
    reference = new ReferenceUnitGrid(map);
  let seed = 17;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const units = Array.from({ length: 6000 }, (_, id) => {
    const state = {
      tile: random() % (width * height),
      old: 0,
      active: true,
      building: id % 19 === 0,
    };
    const type =
      id < 12
        ? UnitType.AtomBomb
        : id % 2
          ? UnitType.Warship
          : UnitType.TradeShip;
    const unit = {
      tile: () => state.tile,
      lastTile: () => state.old,
      type: () => type,
      isActive: () => state.active,
      isUnderConstruction: () => state.building,
      id: () => id,
    } as Unit;
    candidate.addUnit(unit);
    reference.addUnit(unit);
    return { state, unit };
  });
  return { candidate, reference, units, random, width, height };
}

it("matches original results AND predicate order across sparse/dense queries and mutations", () => {
  const { candidate, reference, units, random, width, height } =
    spatialFixture();
  for (let i = 0; i < 600; i++) {
    const { state, unit } = units[random() % units.length];
    if (i % 5 === 0) {
      candidate.removeUnit(unit);
      reference.removeUnit(unit);
    } else if (i % 5 === 1) {
      candidate.addUnit(unit);
      reference.addUnit(unit);
    } else if (i % 5 === 2) {
      state.old = state.tile;
      state.tile = random() % (width * height);
      candidate.updateUnitCell(unit);
      reference.updateUnitCell(unit);
    } else if (i % 5 === 3) state.active = !state.active;
    else state.building = !state.building;
    const tile = random() % (width * height),
      range = [0, 80, 500, 2200, 20000][i % 5];
    const types =
      i % 3 === 0
        ? [UnitType.AtomBomb, UnitType.AtomBomb, UnitType.Warship]
        : i % 3 === 1
          ? [UnitType.AtomBomb, UnitType.MIRVWarhead]
          : UnitType.Warship;
    const visitedA: number[] = [],
      visitedB: number[] = [];
    const a = candidate.nearbyUnits(
      tile,
      range,
      types,
      (v) => {
        visitedA.push(v.unit.id());
        return v.unit.id() % 3 !== 0;
      },
      i % 2 === 0,
    );
    const b = reference.nearbyUnits(
      tile,
      range,
      types,
      (v) => {
        visitedB.push(v.unit.id());
        return v.unit.id() % 3 !== 0;
      },
      i % 2 === 0,
    );
    expect(a).toEqual(b);
    expect(visitedA).toEqual(visitedB);
  }
});

it("tracks the actual indexed cell when a catch-up update skips intermediate positions", () => {
  const { candidate, units, width } = spatialFixture();
  const { state, unit } = units[0];
  const before = state.tile;
  state.old = 300 * width + 300;
  state.tile = 700 * width + 700;
  candidate.updateUnitCell(unit);
  expect(
    candidate.nearbyUnits(before, 0, UnitType.AtomBomb, undefined, true),
  ).toHaveLength(0);
  expect(
    candidate
      .nearbyUnits(state.tile, 1, UnitType.AtomBomb, undefined, true)
      .map((v) => v.unit),
  ).toContain(unit);
  state.tile = 900 * width + 900;
  candidate.removeUnit(unit);
  expect(
    candidate
      .nearbyUnits(700 * width + 700, 20000, UnitType.AtomBomb, undefined, true)
      .map((v) => v.unit),
  ).not.toContain(unit);
});
