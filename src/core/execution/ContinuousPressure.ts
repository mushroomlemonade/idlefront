import type { Game, Player } from "../game/Game";
import { PressureContactIndex } from "../game/PressureContactIndex";
import { hasPressureGrace } from "../game/PressureDiplomacy";
import { AttackExecution } from "./AttackExecution";
import { applyPressureStrategy } from "./PressureStrategy";
import { usesNationStrategy } from "./nation/NationStrategy";

/** One cached contact count per neighbour, not one execution per boundary tile.
 * Ownership/terrain changes invalidate only adjacent players. Military and
 * diplomatic balance is reconsidered once a game second, staggered by player.
 */
class Frontiers extends PressureContactIndex {
  constructor(game: Game) {
    super(game);
  }
  width(player: Player): number {
    let width = 0;
    for (const [id, count] of this.counts(player)) {
      const other = this.game.playerBySmallID(id);
      if (
        !hasPressureGrace(this.game, other) &&
        (!other.isPlayer() || !player.isFriendly(other))
      )
        width += count;
    }
    return Math.max(1, width);
  }
}
const frontiers = new WeakMap<Game, Frontiers>();
export function applyContinuousPressure(
  game: Game,
  player: Player,
  tick: number,
): void {
  if (
    !game.config().gameConfig().continuousPressure ||
    usesNationStrategy(game, player) ||
    game.inSpawnPhase() ||
    tick % 10 !== player.smallID() % 10
  )
    return;
  let index = frontiers.get(game);
  if (!index) {
    index = new Frontiers(game);
    frontiers.set(game, index);
  }
  const width = index.width(player),
    free = player.troops();
  if (applyPressureStrategy(game, player, tick, index)) return;
  if (free < 20) return;
  const ownStrength = free / width;
  const pending = new Set(
    player
      .outgoingAttacks()
      .filter((a) => a.isActive())
      .map((a) => a.target().smallID()),
  );
  const budget = Math.floor(free * 0.08);
  let spent = 0;
  for (const [id, contact] of index.get(player)) {
    if (pending.has(id)) continue;
    const target = game.playerBySmallID(id);
    if (hasPressureGrace(game, target)) continue;
    if (target.isPlayer()) {
      if (player.isFriendly(target) || !target.isAlive()) continue;
      const resistance =
        (target.troops() / index.width(target)) *
        (target.isTraitor() ? 0.75 : 1);
      // Hysteresis avoids attacks and repeated path searches on balanced fronts.
      if (ownStrength <= resistance * 1.05) continue;
    }
    const amount = Math.min(
      budget - spent,
      Math.floor((budget * contact) / width),
    );
    if (amount < 1) continue;
    spent += amount;
    game.addExecution(
      new AttackExecution(
        amount,
        player,
        target.isPlayer() ? target.id() : null,
        null,
        true,
        !target.isPlayer() &&
          game.config().gameConfig().passiveWildernessExpansion === true,
      ),
    );
  }
}
