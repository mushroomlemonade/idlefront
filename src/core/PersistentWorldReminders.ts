const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Human-readable intervals used by the lobby UI and email scheduler. Keeping
// this list shared prevents the browser from advertising a reminder the
// durable job runner would round differently.
const FRIENDLY_LEAD_TIMES_MS = [
  30 * SECOND,
  1 * MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  45 * MINUTE,
  60 * MINUTE,
  90 * MINUTE,
  2 * HOUR,
  3 * HOUR,
  4 * HOUR,
  6 * HOUR,
  8 * HOUR,
  12 * HOUR,
  1 * DAY,
  2 * DAY,
  3 * DAY,
  5 * DAY,
  7 * DAY,
] as const;

/**
 * Generates the three optional reminder leads promised by a persistent-world
 * invitation. The ratios intentionally make a fourteen-day invitation offer
 * 2 days, 12 hours and 90 minutes. Very short invitations still receive three
 * distinct, useful choices when enough time exists.
 */
export function inferredReminderLeadTimes(
  invitationLifetimeMs: number,
): number[] {
  if (!Number.isFinite(invitationLifetimeMs) || invitationLifetimeMs < MINUTE) {
    return [];
  }

  const maximum = invitationLifetimeMs - 30 * SECOND;
  const available = FRIENDLY_LEAD_TIMES_MS.filter((value) => value <= maximum);
  if (available.length === 0) return [];

  const selected = new Set<number>();
  for (const target of [
    invitationLifetimeMs / 7,
    invitationLifetimeMs / 28,
    invitationLifetimeMs / 224,
  ]) {
    let best: number | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of available) {
      if (selected.has(candidate)) continue;
      const distance = Math.abs(candidate - target);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best !== undefined) selected.add(best);
  }

  return [...selected].sort((a, b) => b - a);
}

export const persistentWorldReminderUnits = {
  second: SECOND,
  minute: MINUTE,
  hour: HOUR,
  day: DAY,
} as const;
