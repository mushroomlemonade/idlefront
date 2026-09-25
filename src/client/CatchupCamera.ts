import type { EventBus } from "../core/EventBus";
import { FitMapEvent } from "./TransformHandler";

/** Camera presentation only: never delays snapshot application or live turns. */
export class CatchupCamera {
  active = false;
  private initialLoad = true;
  constructor(private events: EventBus) {}

  update(pendingTurns: number, snapshotPhase?: "begin" | "part" | "end"): void {
    // A conquest can briefly queue live updates. It is not a new join and must
    // never reset the player's camera. Only the first load gets an overview.
    const catchingUp = pendingTurns > 1 || snapshotPhase === "begin" || snapshotPhase === "part";
    if (!this.initialLoad) {
      this.active = false;
      return;
    }
    if (catchingUp && !this.active) this.events.emit(new FitMapEvent());
    this.active = catchingUp;
    if (snapshotPhase === "end" || !catchingUp) {
      this.initialLoad = false;
      this.active = false;
    }
  }
}
