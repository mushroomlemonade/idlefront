import type { Game } from "../../core/game/Game";
import type { Turn } from "../../core/Schemas";
import { ADMIN_BOT_CLIENT_ID } from "../../core/Schemas";
import type { GameFog } from "./GameFog";

/** Deterministic validation is repeated during journal recovery. */
export function fogPermittedIntents(
  game: Game,
  fog: GameFog,
  turn: Turn,
): Turn {
  return {
    ...turn,
    intents: turn.intents.filter((intent) => {
      if (intent.clientID === ADMIN_BOT_CLIENT_ID)
        return intent.type === "toggle_pause";
      let view;
      try {
        view = fog.forClient(intent.clientID);
      } catch {
        return false;
      }
      switch (intent.type) {
        case "spawn":
          return game.inSpawnPhase();
        case "boat":
          return view.isExplored(intent.dst);
        case "build_unit":
          return view.isVisible(intent.tile);
        case "attack":
          return (
            intent.targetID === null ||
            (game.hasPlayer(intent.targetID) &&
              view.canInspectPlayer(game.player(intent.targetID).smallID()))
          );
        // Warships may navigate into uncharted water, but do not gain knowledge
        // of enemy units there until their actual scouting radius reaches them.
        case "move_warship":
          return game.isValidRef(intent.tile);
        default:
          return true; // Ownership/resource checks remain in the engine.
      }
    }),
  };
}
