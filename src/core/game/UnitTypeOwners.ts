import type { UnitType } from "./Game";
import type { PlayerImpl } from "./PlayerImpl";

/** Reuses per-player buckets, indexing only owners with units of this type. */
export class UnitTypeOwners {
  private owners = new Map<UnitType, Set<PlayerImpl>>();
  private ordered = new Map<UnitType, readonly PlayerImpl[]>();
  add(type: UnitType, player: PlayerImpl): void {
    let owners = this.owners.get(type);
    if (!owners) this.owners.set(type, (owners = new Set()));
    if (owners.has(player)) return;
    owners.add(player);
    this.ordered.delete(type);
  }
  remove(type: UnitType, player: PlayerImpl): void {
    if (!this.owners.get(type)?.delete(player)) return;
    this.ordered.delete(type);
  }
  get(type: UnitType): readonly PlayerImpl[] {
    let ordered = this.ordered.get(type);
    if (!ordered) {
      // Small IDs are assigned monotonically by GameImpl.addPlayer.
      ordered = [...(this.owners.get(type) ?? [])].sort(
        (a, b) => a.smallID() - b.smallID(),
      );
      this.ordered.set(type, ordered);
    }
    return ordered;
  }
}
