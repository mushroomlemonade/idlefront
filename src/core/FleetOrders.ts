import { z } from "zod";
import { MAX_FLEET_TARGET } from "./FleetAffordability";

export const FleetOrdersSchema = z
  .object({
    enabled: z.boolean(),
    // Omission preserves legacy port selection and replays.
    automaticPorts: z.boolean().optional(),
    target: z.number().int().min(0).max(MAX_FLEET_TARGET),
    reserve: z.number().int().min(0).max(1_000_000_000_000),
    // Explicit IDs: captured and newly built ports never silently join the list.
    ports: z.array(z.number().int().nonnegative()).max(64),
    order: z.enum(["defend", "escort", "patrol"]),
    patrolTile: z.number().int().nonnegative().optional(),
  })
  .strict();
export type FleetOrders = z.infer<typeof FleetOrdersSchema>;
export type FleetStatus =
  | "disabled"
  | "target met"
  | "reserve reached"
  | "no eligible port"
  | "no valid build location"
  | "building"
  | "unit disabled";
export interface FleetView extends FleetOrders {
  revision: number;
  status: FleetStatus;
  pending: number;
}
