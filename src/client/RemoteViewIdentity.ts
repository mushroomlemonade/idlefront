import {
  GameUpdateType,
  type GameUpdateViewData,
} from "../core/game/GameUpdates";
import { ANONYMOUS_SIMULATION_NAME } from "../core/network/ViewIdentity";
import type { GameStartInfo } from "../core/Schemas";
import { formatPlayerDisplayName } from "../core/Util";

/** Presentation only: identities come exclusively from the authorized start. */
export class RemoteViewIdentity {
  private players: Map<string, GameStartInfo["players"][number]>;
  private playerNames = new Map<string, string>();
  constructor(private start: GameStartInfo) {
    this.players = new Map(start.players.map((p) => [p.clientID, p]));
  }

  private displayText(text: string): string {
    return text.replace(ANONYMOUS_SIMULATION_NAME, (token, index: string) => {
      const player = this.start.players[Number(index)];
      return player
        ? formatPlayerDisplayName(player.username, player.clanTag)
        : token;
    });
  }

  apply(update: GameUpdateViewData): void {
    for (const player of update.updates[GameUpdateType.Player]) {
      if (!player.clientID) continue;
      const identity = this.players.get(player.clientID);
      if (!identity) continue;
      player.name = identity.username;
      player.clanTag = identity.clanTag;
      player.displayName = formatPlayerDisplayName(
        identity.username,
        identity.clanTag,
      );
      this.playerNames.set(player.id, player.displayName);
    }
    if (!this.start.config.anonymizeNames) return;

    for (const event of update.updates[GameUpdateType.DisplayEvent]) {
      event.message = this.displayText(event.message);
      if (event.params) {
        for (const [key, value] of Object.entries(event.params))
          if (typeof value === "string")
            event.params[key] = this.displayText(value);
      }
    }
    for (const event of update.updates[GameUpdateType.UnitIncoming])
      event.message = this.displayText(event.message);

    // The expensive territory rectangle search stays on the server. Only the
    // final, constant-time font fit depends on the viewer's permitted name.
    for (const [id, placement] of Object.entries(
      update.playerNameViewData ?? {},
    )) {
      const name = this.playerNames.get(id);
      const bounds = placement.bounds;
      if (!name || !bounds) continue;
      placement.size = Math.min(
        (bounds.width / name.length) * 2,
        bounds.height / 3,
      );
      placement.y = Math.ceil(bounds.centerY - placement.size / 3);
    }
  }
}
