import { PlayerType, type Game, type Player, type TerraNullius } from "./Game";

/** Global game-time protection, not a fresh timer on reconnect or late join. */
export function hasPressureGrace(
  game: Game,
  target: Player | TerraNullius,
): boolean {
  const config = game.config().gameConfig();
  return (
    !!config.continuousPressure &&
    target.isPlayer() &&
    target.type() !== PlayerType.Bot &&
    game.elapsedGameSeconds() < (config.pressureGraceSeconds ?? 0)
  );
}

export function hasProtectedAlliance(
  game: Game,
  attacker: Player,
  target: Player | TerraNullius,
): boolean {
  if (
    !game.config().gameConfig().continuousPressure ||
    !target.isPlayer() ||
    target === attacker
  )
    return false;
  const alliance = attacker.allianceWith(target);
  return alliance !== null && game.ticks() < alliance.expiresAt();
}
