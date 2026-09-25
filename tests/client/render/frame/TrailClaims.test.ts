import { describe, expect, it } from "vitest";
import { TrailClaims } from "../../../../src/client/render/frame/TrailClaims";
import { TrailManager } from "../../../../src/client/render/frame/TrailManager";

describe("sparse trail claims", () => {
  it("allocates nothing for a world without trails, even at XL coordinates", () => {
    const counts = new TrailClaims();
    expect(counts.allocatedBytes).toBe(0);
    counts.claim(72_021_455);
    expect(counts.allocatedBytes).toBe(4096);
    expect(counts.release(72_021_455)).toBe(true);
    expect(counts.allocatedBytes).toBe(0);
  });

  it("preserves shared tiles until the last unit releases them", () => {
    const counts = new TrailClaims();
    counts.claim(1023);
    counts.claim(1023);
    counts.claim(1024);
    expect(counts.allocatedBytes).toBe(8192);
    expect(counts.release(1023)).toBe(false);
    expect(counts.release(1024)).toBe(true);
    expect(counts.allocatedBytes).toBe(4096);
    expect(counts.release(1023)).toBe(true);
    expect(counts.allocatedBytes).toBe(0);
  });

  it("matches dense reference counts during repeated overlaps and deaths", () => {
    const counts = new TrailClaims();
    const reference = new Uint32Array(10_000);
    let seed = 13;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 60_000; i++) {
      const ref = next() % reference.length;
      if (next() % 3 || !reference[ref]) {
        reference[ref]++;
        counts.claim(ref);
      } else {
        expect(counts.release(ref)).toBe(--reference[ref] === 0);
      }
    }
    for (let ref = 0; ref < reference.length; ref++) {
      while (reference[ref]) {
        expect(counts.release(ref)).toBe(--reference[ref] === 0);
      }
    }
    expect(counts.allocatedBytes).toBe(0);
  });

  it("clears pages for reset and can reuse a previously freed page", () => {
    const counts = new TrailClaims();
    counts.claim(2);
    counts.claim(2000);
    counts.clear();
    expect(counts.allocatedBytes).toBe(0);
    counts.claim(2);
    expect(counts.release(2)).toBe(true);
    expect(counts.release(2)).toBe(true);
    expect(counts.allocatedBytes).toBe(0);
  });
});

describe("paged trail storage", () => {
  it("does not allocate a world-sized compatibility buffer", () => {
    const trails = new TrailManager(20_000, 10_000, true);
    expect(trails.getTrailState().length).toBe(0);
    expect(trails.getSparseState()).toEqual(new Map());
  });
});
