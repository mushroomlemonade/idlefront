import type { BuildableUnit, Game } from "../../core/game/Game";
import type { ViewQuery } from "../../core/network/ViewProtocol";
import type { WorkerMessage } from "../../core/worker/WorkerMessages";

export interface QueryVisibility {
  isVisible(tile: number): boolean;
  isExplored?(tile: number): boolean;
  canInspectPlayer(smallID: number): boolean;
}

/** The viewer comes from the authenticated socket, never the query payload/IP. */
export function authorizeViewQuery(
  game: Game,
  clientID: string,
  query: ViewQuery,
  visibility?: QueryVisibility,
): void {
  const viewer = game.playerByClientID(clientID);
  const actsAsPlayer =
    query.type === "player_actions" ||
    query.type === "player_buildables" ||
    query.type === "transport_ship_spawn";
  if (actsAsPlayer && (!viewer || String(query.playerID) !== viewer.id()))
    throw new Error("Action query does not belong to this player");
  if (!visibility) return;
  if (!viewer) throw new Error("A player seat is required for this view");
  if (query.x !== undefined || query.y !== undefined) {
    if (
      query.x === undefined ||
      query.y === undefined ||
      !game.isValidCoord(query.x, query.y) ||
      !visibility.isVisible(game.ref(query.x, query.y))
    )
      throw new Error("That location is outside your current view");
  }
  if (
    query.targetTile !== undefined &&
    !(query.type === "transport_ship_spawn" && visibility.isExplored
      ? visibility.isExplored(query.targetTile)
      : visibility.isVisible(query.targetTile))
  )
    throw new Error("That location is outside your current view");
  if (
    query.type === "player_profile" ||
    query.type === "attack_clustered_positions"
  ) {
    if (!visibility.canInspectPlayer(Number(query.playerID)))
      throw new Error("That player is outside your current view");
  }
  if (query.type === "player_border_tiles") {
    const target = game.player(String(query.playerID));
    if (!visibility.canInspectPlayer(target.smallID()))
      throw new Error("That player is outside your current view");
  }
}

/** Authorization alone is insufficient for results containing remote geometry. */
export function projectViewQueryResult(
  game: Game,
  visibility: QueryVisibility,
  message: WorkerMessage,
): WorkerMessage {
  const buildable = (unit: BuildableUnit): BuildableUnit => ({
    ...unit,
    overlappingRailroads: unit.overlappingRailroads.filter((tile) =>
      visibility.isVisible(tile),
    ),
    ghostRailPaths: unit.ghostRailPaths.filter((path) =>
      path.every((tile) => visibility.isVisible(tile)),
    ),
  });
  switch (message.type) {
    case "player_border_tiles_result":
      return {
        ...message,
        result: {
          borderTiles: new Set(
            [...message.result.borderTiles].filter((tile) =>
              visibility.isVisible(tile),
            ),
          ),
        },
      };
    case "attack_clustered_positions_result":
      return {
        ...message,
        attacks: message.attacks
          .map((attack) => ({
            ...attack,
            positions: attack.positions.filter(
              (pos) =>
                game.isValidCoord(pos.x, pos.y) &&
                visibility.isVisible(game.ref(pos.x, pos.y)),
            ),
          }))
          .filter((attack) => attack.positions.length > 0),
      };
    case "player_profile_result":
      return {
        ...message,
        result: {
          alliances: message.result.alliances.filter((id) =>
            visibility.canInspectPlayer(id),
          ),
          relations: Object.fromEntries(
            Object.entries(message.result.relations).filter(([id]) =>
              visibility.canInspectPlayer(Number(id)),
            ),
          ),
        },
      };
    case "player_buildables_result":
      return { ...message, result: message.result.map(buildable) };
    case "player_actions_result":
      return {
        ...message,
        result: {
          ...message.result,
          buildableUnits: message.result.buildableUnits.map(buildable),
        },
      };
    default:
      return message;
  }
}
