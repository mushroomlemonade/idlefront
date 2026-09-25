import {
  PlayerType,
  UnitType,
  type Game,
  type Player,
  type TerraNullius,
} from "../../core/game/Game";
import type { GameFog } from "./GameFog";

/**
 * Conservative first tier of simulation LOD: isolated bot land frontiers do
 * real work at 1Hz, not a backlog of full ticks. Income, diplomacy, AI decisions,
 * structures and vehicles keep their ordinary clocks. This intentionally
 * approximates hidden bot expansion; it is NOT outcome-equivalent optimization.
 */
export class BotActivity {
  /** Bounds wilderness-front growth cost even after hours of hidden expansion. */
  static readonly REMOTE_EXPANSION_BUDGET = 64;
  private readonly protectedOwners = new Set<number>();
  private readonly unsubscribe: () => void;
  readonly stride: number;
  considered = 0;
  skipped = 0;
  get protectedCount(): number {
    return this.protectedOwners.size;
  }

  constructor(
    private readonly game: Game,
    private readonly fog: GameFog,
  ) {
    this.stride = Math.max(1, Math.round(1000 / game.config().msPerTick()));
    // If a frontier reaches an active country within a tick, promote before
    // the next attack execution. Never demote until the next turn boundary.
    this.unsubscribe = game.observeTerritory((tile, before, after) => {
      let contact =
        this.protectedOwners.has(before) || this.protectedOwners.has(after);
      game.forEachNeighbor(tile, (n) => {
        if (this.protectedOwners.has(game.ownerID(n))) contact = true;
      });
      if (!contact) return;
      if (before) this.protectedOwners.add(before);
      if (after) this.protectedOwners.add(after);
      game.forEachNeighbor(tile, (n) => {
        const owner = game.ownerID(n);
        if (owner) this.protectedOwners.add(owner);
      });
    });
    game.setAttackActivityPolicy((attacker, target, tick) =>
      this.expansionBudget(attacker, target, tick),
    );
  }

  beginTurn(): void {
    this.protectedOwners.clear();
    this.considered = this.skipped = 0;
    for (const player of this.game.allPlayers()) {
      if (
        player.type() === PlayerType.Human ||
        this.fog.isObservedPlayer(player.smallID())
      ) {
        this.protectedOwners.add(player.smallID());
        for (const ally of player.allies())
          this.protectedOwners.add(ally.smallID());
      }
    }
    const interactionOwners = new Set(this.protectedOwners);
    for (const unit of this.game.units()) {
      // Units/industry themselves ALWAYS tick normally. Owning an unseen city
      // is not a reason to wake an entire remote land frontier; that erased
      // the saving as soon as nations built their first cities in profiling.
      if (this.fog.isObservedTile(unit.tile()))
        this.protectedOwners.add(unit.owner().smallID());
      if (unit.type() !== UnitType.TradeShip) continue;
      const target = unit.targetUnit();
      if (
        target &&
        (interactionOwners.has(unit.owner().smallID()) ||
          interactionOwners.has(target.owner().smallID()))
      ) {
        this.protectedOwners.add(unit.owner().smallID());
        this.protectedOwners.add(target.owner().smallID());
      }
    }
    // A guard ring beyond observed nations wakes land opponents before contact.
    for (const owner of [...this.protectedOwners])
      for (const neighbor of this.fog.contacts.neighborsOf(owner))
        if (neighbor) this.protectedOwners.add(neighbor);
  }

  expansionBudget(
    attacker: Player,
    target: Player | TerraNullius,
    tick: number,
  ): number {
    if (
      this.game.inSpawnPhase() ||
      attacker.type() === PlayerType.Human ||
      this.protectedOwners.has(attacker.smallID()) ||
      (target.isPlayer() &&
        (target.type() === PlayerType.Human ||
          this.protectedOwners.has(target.smallID())))
    )
      return Infinity;
    this.considered++;
    // Stable staggering spreads work; no wall clock or socket presence enters
    // deterministic recovery. No tick is replayed when the bot becomes active.
    const run = tick % this.stride === attacker.smallID() % this.stride;
    if (!run) this.skipped++;
    return run ? BotActivity.REMOTE_EXPANSION_BUDGET : 0;
  }

  dispose(): void {
    this.unsubscribe();
    this.game.setAttackActivityPolicy(undefined);
  }
}
