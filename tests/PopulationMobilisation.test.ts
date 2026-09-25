import {
  civilianIncomeMultiplier,
  donatePopulationTroops,
  mobilisePopulation,
} from "../src/core/game/PopulationMobilisation";
import {
  CUSTOM_WORLD_PRESETS,
  presetForDuration,
  WORLD_PRESETS,
} from "../src/core/WorldPresets";

describe("continuous pressure foundation", () => {
  const population = { civilians: 800, troops: 200, committedTroops: 0 };
  it("mobilises halfway toward the target in one configured half-life", () => {
    expect(mobilisePopulation(population, 0.8, 30, 30)).toEqual({
      civilians: 500,
      troops: 500,
      committedTroops: 0,
    });
  });
  it("is independent of tick subdivision, with no population creation", () => {
    let many = population;
    for (let i = 0; i < 600; i++) many = mobilisePopulation(many, 0.9, 0.1, 30);
    const once = mobilisePopulation(population, 0.9, 60, 30);
    expect(many.troops).toBeCloseTo(once.troops, 8);
    expect(many.civilians + many.troops).toBeCloseTo(1000, 8);
  });
  it("does not demobilise committed troops", () => {
    const result = mobilisePopulation(
      { civilians: 200, troops: 800, committedTroops: 700 },
      0,
      3600,
      1,
    );
    expect(result.troops).toBe(700);
    expect(result.civilians).toBe(300);
  });
  it("donates immediately without converting civilians or duplicating troops", () => {
    const result = donatePopulationTroops(population, population, 125);
    expect(result.sender.troops).toBe(75);
    expect(result.recipient.troops).toBe(325);
    expect(
      result.sender.civilians +
        result.recipient.civilians +
        result.sender.troops +
        result.recipient.troops,
    ).toBe(2000);
    expect(() =>
      donatePopulationTroops(
        { ...population, committedTroops: 100 },
        population,
        101,
      ),
    ).toThrow();
  });
  it("bases income on actual civilians and bounds the curve", () => {
    expect(civilianIncomeMultiplier(population)).toBe(1.8);
    expect(
      civilianIncomeMultiplier({ civilians: 0, troops: 0, committedTroops: 0 }),
    ).toBe(1);
    expect(
      civilianIncomeMultiplier({
        civilians: 1000,
        troops: 0,
        committedTroops: 0,
      }),
    ).toBe(2);
  });
  it("rejects malformed accounting and rates", () => {
    expect(() => mobilisePopulation(population, 2, 1, 30)).toThrow();
    expect(() => mobilisePopulation(population, 0.5, 1, 0)).toThrow();
    expect(() => mobilisePopulation(population, 0.5, NaN, 30)).toThrow();
  });
  it("exposes only the three new modes and their agreed protections", () => {
    expect(CUSTOM_WORLD_PRESETS).toEqual([
      "quickplay",
      "longplay",
      "idlefront",
    ]);
    expect(
      ["1h", "1d", "7d"].map(
        (d) =>
          WORLD_PRESETS[presetForDuration(d as "1h" | "1d" | "7d")]
            .allianceProtectionMinutes,
      ),
    ).toEqual([5, 30, 720]);
    expect(CUSTOM_WORLD_PRESETS.map((id) => WORLD_PRESETS[id].scale)).toEqual([
      1, 9, 27,
    ]);
  });
});
