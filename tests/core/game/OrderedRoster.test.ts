import { OrderedRoster } from "../../../src/core/game/OrderedRoster";

describe("ordered roster array semantics", () => {
  it("retains removed entries in an existing iterator but extends it on additions before removal", () => {
    const roster = new OrderedRoster<number>();
    roster.add(1);
    roster.add(2);
    const first = roster.snapshot();
    const iterator = first.values();
    expect(iterator.next().value).toBe(1);
    roster.add(3);
    expect(first).toEqual([1, 2, 3]);
    roster.delete(2);
    roster.add(4);
    expect([...iterator]).toEqual([2, 3]);
    expect(roster.snapshot()).toEqual([1, 3, 4]);
    expect(roster.snapshot()).not.toBe(first);
    const second = roster.snapshot();
    roster.add(5);
    expect(roster.snapshot()).toBe(second);
    expect(second).toEqual([1, 3, 4, 5]);
  });

  it("preserves forEach length capture and remove/re-add order", () => {
    const roster = new OrderedRoster<number>();
    roster.add(1);
    roster.add(2);
    const visited: number[] = [];
    roster.snapshot().forEach((value) => {
      visited.push(value);
      roster.add(3);
    });
    expect(visited).toEqual([1, 2]);
    roster.delete(1);
    roster.add(1);
    expect(roster.snapshot()).toEqual([2, 3, 1]);
  });

  it("matches push/filter across 10000 mutations including retained snapshots", () => {
    const roster = new OrderedRoster<number>();
    let reference: number[] = [];
    const retained: Array<[number[], number[]]> = [];
    let seed = 17;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    let next = 0;
    for (let step = 0; step < 10000; step++) {
      if (reference.length && random() % 3 === 0) {
        const value = reference[random() % reference.length];
        roster.delete(value);
        reference = reference.filter((entry) => entry !== value);
      } else {
        roster.add(++next);
        reference.push(next);
      }
      if (step % 113 === 0) retained.push([reference, roster.snapshot()]);
      if (step % 37 === 0) {
        expect(roster.snapshot()).toEqual(reference);
        for (const [before, after] of retained) expect(after).toEqual(before);
      }
    }
  });
});
