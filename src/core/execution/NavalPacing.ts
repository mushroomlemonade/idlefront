import { Game } from "../game/Game";

/** Strategy cadence follows the same pacing control as army preparation. */
export function navalPacingScale(game: Game): number {
  const halfLife =
    game.config().gameConfig().pressurePacing?.mobilisationHalfLifeSeconds ?? 5;
  return Math.max(1, Math.min(720, halfLife / 5));
}
