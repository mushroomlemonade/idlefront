import { z } from "zod";

/** Game seconds, shared by manual and automatic mobilisation. New worlds use
 * the native population curve with a rate multiplier in every mode. Doubling
 * times remain for legacy saved configs. These are tuning values, not duration guarantees.
 */
export const PressurePacingSchema = z
  .object({
    // Presence opts into the native curve. Absence preserves existing replays.
    populationGrowthMultiplier: z
      .number()
      .finite()
      .min(0.01)
      .max(100)
      .optional(),
    populationDoublingSeconds: z.number().finite().min(60).max(604800),
    mobilisationHalfLifeSeconds: z.number().finite().min(1).max(86400),
  })
  .strict();
export type PressurePacing = z.infer<typeof PressurePacingSchema>;

const DEFAULTS: Record<"1h" | "1d" | "7d", Readonly<PressurePacing>> = {
  "1h": {
    populationGrowthMultiplier: 1,
    populationDoublingSeconds: 600,
    mobilisationHalfLifeSeconds: 5,
  },
  // Retain the intended slower pacing without selecting the legacy formula.
  "1d": {
    populationGrowthMultiplier: 1 / 12,
    populationDoublingSeconds: 7200,
    mobilisationHalfLifeSeconds: 10,
  },
  "7d": {
    populationGrowthMultiplier: 0.01,
    populationDoublingSeconds: 86400,
    mobilisationHalfLifeSeconds: 3600,
  },
};

export function pressurePacingForDuration(
  duration: "1h" | "1d" | "7d",
): PressurePacing {
  return { ...DEFAULTS[duration] };
}
