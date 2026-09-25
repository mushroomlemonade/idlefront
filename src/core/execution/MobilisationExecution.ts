import type { Execution, Game, Player } from "../game/Game";
import { setMobilisationTarget } from "../game/PressurePopulation";
export class MobilisationExecution implements Execution {
  constructor(
    private player: Player,
    private target: number,
    private autoDefenceEnabled?: boolean,
  ) {}
  init(game: Game): void {
    setMobilisationTarget(
      game,
      this.player,
      this.target,
      this.autoDefenceEnabled,
    );
  }
  tick(): void {}
  isActive(): boolean {
    return false;
  }
  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
