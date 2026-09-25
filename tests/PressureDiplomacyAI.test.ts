import { AllianceExtensionExecution } from "../src/core/execution/alliance/AllianceExtensionExecution";
import { AllianceRequestExecution } from "../src/core/execution/alliance/AllianceRequestExecution";
import { NationAllianceBehavior } from "../src/core/execution/nation/NationAllianceBehavior";
import { NationEmojiBehavior } from "../src/core/execution/nation/NationEmojiBehavior";
import { Game, Player, PlayerType, Relation } from "../src/core/game/Game";
import { nationPersonality } from "../src/core/game/NationPersonality";
import { PseudoRandom } from "../src/core/PseudoRandom";
import { playerInfo, setup } from "./util/Setup";

function fixture(type = PlayerType.Human) {
  let tick = 2000;
  const other = {
    id: () => "other",
    type: () => type,
    isAlive: () => true,
    isPlayer: () => true,
    isTraitor: () => false,
    troops: () => 1000,
    outgoingAttacks: () => [],
  } as unknown as Player;
  const player = {
    id: () => "nation",
    smallID: () => 1,
    type: () => PlayerType.Nation,
    isAlive: () => true,
    relation: () => Relation.Friendly,
    alliances: () => [],
    incomingAttacks: () => [],
    outgoingAttacks: () => [],
    troops: () => 1000,
    nearby: () => [other],
    isFriendly: () => false,
    canSendAllianceRequest: () => true,
  } as unknown as Player;
  const game = {
    ticks: () => tick,
    inSpawnPhase: () => false,
    players: () => [player, other],
    config: () => ({
      gameConfig: () => ({ continuousPressure: "v1" }),
      disableAlliances: () => false,
      allianceExtensionPromptOffset: () => 100,
    }),
    addExecution: vi.fn(),
  } as unknown as Game;
  const ai = new NationAllianceBehavior(
    new PseudoRandom(1),
    game,
    player,
    {} as NationEmojiBehavior,
  );
  return {
    ai,
    player,
    other,
    game,
    advance: () => {
      tick += 700;
    },
  };
}

test.each([PlayerType.Human, PlayerType.Nation])(
  "nations invite useful %s partners with bounded retries",
  (type) => {
    const { ai, game, advance } = fixture(type);
    ai.maybePressureDiplomacy();
    ai.maybePressureDiplomacy();
    expect(game.addExecution).toHaveBeenCalledTimes(1);
    expect(game.addExecution).toHaveBeenCalledWith(
      expect.any(AllianceRequestExecution),
    );
    advance();
    ai.maybePressureDiplomacy();
    expect(game.addExecution).toHaveBeenCalledTimes(1);
  },
);

test.each(["tribe", "traitor", "distrust", "full"])(
  "rejects unsuitable diplomacy: %s",
  (reason) => {
    const { ai, player, other, game } = fixture();
    if (reason === "tribe")
      vi.spyOn(other, "type").mockReturnValue(PlayerType.Bot);
    if (reason === "traitor")
      vi.spyOn(other, "isTraitor").mockReturnValue(true);
    if (reason === "distrust")
      vi.spyOn(player, "relation").mockReturnValue(Relation.Distrustful);
    if (reason === "full")
      vi.spyOn(player, "alliances").mockReturnValue([
        { other: () => other, expiresAt: () => 99999 } as any,
      ]);
    ai.maybePressureDiplomacy();
    expect(game.addExecution).not.toHaveBeenCalled();
  },
);

test("valuable alliances are proactively renewed through the native execution", () => {
  const { ai, player, other, game } = fixture(PlayerType.Nation);
  vi.spyOn(player, "alliances").mockReturnValue([
    {
      other: () => other,
      expiresAt: () => 2050,
      agreedToExtend: () => false,
    } as any,
  ]);
  ai.maybePressureDiplomacy();
  expect(game.addExecution).toHaveBeenCalledWith(
    expect.any(AllianceExtensionExecution),
  );
});

test("authoritative profile exposes actual nation traits, never tribe traits", async () => {
  const game = await setup("ocean_and_land", { continuousPressure: "v1" }, [
    playerInfo("nation", PlayerType.Nation),
    playerInfo("tribe", PlayerType.Bot),
  ]);
  const profile = game.player("nation").playerProfile();
  expect(profile.nationPersonality?.name).toBe(
    nationPersonality("nation").name,
  );
  expect(profile.nationPersonality?.aggression).toBe(
    nationPersonality("nation").aggression,
  );
  expect(
    game.player("tribe").playerProfile().nationPersonality,
  ).toBeUndefined();
});
