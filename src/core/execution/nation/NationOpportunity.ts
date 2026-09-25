import { Game, Player, PlayerType, TerraNullius } from "../../game/Game";
import { nationStrategy, usesNationStrategy } from "./NationStrategy";

export function noteNationStrike(
  game: Game,
  attacker: Player,
  target: Player | TerraNullius,
): void {
  if (
    game.config().gameConfig().nationStrategy === "v2" &&
    usesNationStrategy(game, attacker) &&
    target.isPlayer()
  )
    nationStrategy(game, attacker).noteStrike(target);
}

/** Routine pressure is not a declaration of hostility. A genuinely threatening
 * force is still offensive even when it is a small share of the attacker's army. */
export function significantDiplomaticPush(
  game: Game,
  target: Player | TerraNullius,
  troops: number,
): boolean {
  return (
    game.config().gameConfig().nationStrategy !== "v2" ||
    !target.isPlayer() ||
    target.type() !== PlayerType.Nation ||
    troops >= Math.max(100, target.troops() * 0.15)
  );
}
