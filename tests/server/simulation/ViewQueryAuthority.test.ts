import { expect, it } from "vitest";
import { Relation, type Game } from "../../../src/core/game/Game";
import { authorizeViewQuery, projectViewQueryResult } from "../../../src/server/simulation/ViewQueryAuthority";

const game = {
  playerByClientID: (id: string) => id === "device-seat" ? { id: () => "nation-a", smallID: () => 1 } : null,
  isValidCoord: (x: number, y: number) => x >= 0 && x < 100 && y >= 0 && y < 100,
  ref: (x: number, y: number) => y * 100 + x,
  player: () => ({ smallID: () => 2 }),
} as unknown as Game;
const sight = { isVisible: (tile: number) => tile < 20, canInspectPlayer: (id: number) => id === 1 };

it("clips allowed query results instead of exposing a known nation's hidden geometry and diplomacy", () => {
  expect(projectViewQueryResult(game, sight, { type: "player_border_tiles_result", id: "1", result: { borderTiles: new Set([1, 19, 20, 90]) } })).toMatchObject({ result: { borderTiles: new Set([1, 19]) } });
  expect(projectViewQueryResult(game, sight, { type: "player_profile_result", id: "2", result: { alliances: [1, 2], relations: { 1: Relation.Neutral, 2: Relation.Friendly } } })).toMatchObject({ result: { alliances: [1], relations: { 1: Relation.Neutral } } });
});

it("binds action queries to the socket's seat, not a requested player or shared IP", () => {
  const query = { type: "player_actions" as const, id: "1", playerID: "nation-a" };
  expect(() => authorizeViewQuery(game, "device-seat", query)).not.toThrow();
  expect(() => authorizeViewQuery(game, "another-seat-same-ip", query)).toThrow();
  expect(() => authorizeViewQuery(game, "device-seat", { ...query, playerID: "nation-b" })).toThrow();
});

it("rejects unseen locations, partial coordinates and hidden profiles when fog is enabled", () => {
  const query = { type: "player_actions" as const, id: "1", playerID: "nation-a" };
  expect(() => authorizeViewQuery(game, "device-seat", { ...query, x: 10, y: 0 }, sight)).not.toThrow();
  expect(() => authorizeViewQuery(game, "device-seat", { ...query, x: 10, y: 1 }, sight)).toThrow();
  expect(() => authorizeViewQuery(game, "device-seat", { ...query, x: 10 }, sight)).toThrow();
  expect(() => authorizeViewQuery(game, "device-seat", { type: "player_profile", id: "2", playerID: 2 }, sight)).toThrow();
});
