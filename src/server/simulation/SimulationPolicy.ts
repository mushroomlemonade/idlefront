import type { GameStartInfo } from "../../core/Schemas";
import { anonymousSimulationName } from "../../core/network/ViewIdentity";

/** Empty rolling lobbies need no worker; all populated online games default on. */
export function usesServerSimulation(start: GameStartInfo): boolean {
  // Fog cannot fall back to broadcasting the authoritative input journal.
  // Its per-seat projection is a security boundary, not a rendering option.
  if (start.config.fogOfWar === "v0.2") return true;
  return (
    process.env.IDLE_SERVER_SIMULATION !== "0" &&
    start.config.serverSimulation !== false &&
    start.players.length > 0
  );
}

/**
 * Input must be the ordinary wire roster, including listed/disableClanTags.
 * Archives keep the original roster. Anonymous games used to simulate with
 * clan/friend grouping disabled on every viewer; preserve that exact input.
 * The shared worker never knows the hidden human names or cosmetics, so no
 * snapshot, notification, or future query can accidentally disclose them.
 */
export function simulationStartInfo(wire: GameStartInfo): GameStartInfo {
  if (!wire.config.anonymizeNames) return wire;
  return {
    ...wire,
    players: wire.players.map((player, index) => ({
      ...player,
      username: anonymousSimulationName(index),
      clanTag: null,
      friends: undefined,
      cosmetics: undefined,
    })),
  };
}
