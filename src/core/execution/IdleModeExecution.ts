import { type Execution, type Game, type Player } from "../game/Game";
import { setExplicitIdle } from "../game/PressurePopulation";

export class IdleModeExecution implements Execution {
  constructor(
    private player: Player,
    private idle: boolean,
  ) {}
  init(game: Game): void {
    setExplicitIdle(game, this.player, this.idle);
  }
  tick(): void {}
  isActive(): boolean {
    return false;
  }
  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
