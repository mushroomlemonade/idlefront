import { z } from "zod";

/** Game seconds, shared by manual and automatic mobilisation. Population
 * growth is expressed as the time to double an uncapped population. These
 * are initial tuning values, not guarantees about match duration.
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
  "1d": { populationDoublingSeconds: 7200, mobilisationHalfLifeSeconds: 10 },
  "7d": { populationDoublingSeconds: 86400, mobilisationHalfLifeSeconds: 3600 },
};

export function pressurePacingForDuration(
  duration: "1h" | "1d" | "7d",
): PressurePacing {
  return { ...DEFAULTS[duration] };
}
