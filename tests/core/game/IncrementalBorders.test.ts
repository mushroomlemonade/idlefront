import { expect, it } from "vitest";
import {
  PlayerInfo,
  PlayerType,
  type Player,
} from "../../../src/core/game/Game";
import { createGame } from "../../../src/core/game/GameImpl";
import { GameMapImpl } from "../../../src/core/game/GameMap";
import { PagedGameMap } from "../../../src/core/game/PagedGameMap";
import { referenceNearby } from "../../util/referenceNearby";
import { setup } from "../../util/Setup";

for (const paged of [false, true])
  for (const queryEvery of [1, 97])
    it(`preserves ordered borders and nearby queries through captures, rivers and fallout (paged=${paged}, queryEvery=${queryEvery})`, async () => {
      const base = await setup("big_plains");
      const terrain = new Uint8Array(48 * 40).fill(128);
      for (let y = 0; y < 40; y++) terrain[y * 48 + 24] = 32;
      const make = () => {
        const map = paged
          ? PagedGameMap.fromRowMajor(48, 40, 16, terrain.slice(), 48 * 40 - 40)
          : new GameMapImpl(48, 40, terrain.slice(), 48 * 40 - 40);
        return createGame(
          ["a", "b", "c"].map(
            (id) => new PlayerInfo(id, PlayerType.Human, id, id),
          ),
          [],
          map,
          map,
          base.config(),
        );
      };
      const actual = make(),
        legacy = make();
      Object.assign(legacy, {
        updateBorders(tile: number) {
          const check = (t: number) => {
            if (!legacy.hasOwner(t)) return;
            const p = legacy.owner(t) as any;
            if (legacy.map().isBorder(t)) p._borderTiles.add(t);
            else p._borderTiles.delete(t);
          };
          check(tile);
          legacy.forEachNeighbor(tile, check);
        },
      });
      let seed = 71;
      const random = () =>
        (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
      for (let i = 0; i < 4000; i++) {
        const tile = random() % (48 * 40),
          id = ["a", "b", "c"][random() % 3];
        if (actual.isWater(tile)) continue;
        for (const game of [actual, legacy]) {
          if (i % 11 === 0 && game.hasOwner(tile))
            (game.owner(tile) as Player).relinquish(tile);
          else if (i % 19 === 0 && !game.hasOwner(tile))
            game.setFallout(tile, true);
          else game.player(id).conquer(tile);
          if (i % 41 === 0 && !game.hasOwner(tile)) game.setWater(tile);
        }
        if (i % queryEvery !== 0 && i !== 3999) continue;
        for (const p of actual.allPlayers()) {
          expect([...p.borderTiles()]).toEqual([
            ...legacy.player(p.id()).borderTiles(),
          ]);
          const expected = referenceNearby(actual, p).map((n) => n.smallID());
          expect(p.nearby().map((n) => n.smallID())).toEqual(expected);
          expect(p.nearby().map((n) => n.smallID())).toEqual(expected);
        }
      }
    }, 20000);
