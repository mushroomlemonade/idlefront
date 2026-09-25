import {
  inferredReminderLeadTimes,
  persistentWorldReminderUnits,
} from "../src/core/PersistentWorldReminders";

describe("persistent-world reminder inference", () => {
  const { minute, hour, day } = persistentWorldReminderUnits;

  it("matches the product examples for a fourteen-day invitation", () => {
    expect(inferredReminderLeadTimes(14 * day)).toEqual([
      2 * day,
      12 * hour,
      90 * minute,
    ]);
  });

  it("keeps short invitation choices distinct and at least thirty seconds", () => {
    expect(inferredReminderLeadTimes(20 * minute)).toEqual([
      2 * minute,
      1 * minute,
      30_000,
    ]);
  });

  it("rejects invalid lifetimes and never schedules after game start", () => {
    expect(inferredReminderLeadTimes(Number.NaN)).toEqual([]);
    expect(inferredReminderLeadTimes(30_000)).toEqual([]);
    expect(
      inferredReminderLeadTimes(5 * minute).every((lead) => lead < 5 * minute),
    ).toBe(true);
  });
});
