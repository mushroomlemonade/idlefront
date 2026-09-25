import { AttackExecution } from "../src/core/execution/AttackExecution";
import {
  applyPressureStrategy,
  pressurePersonality,
} from "../src/core/execution/PressureStrategy";
import { RetreatExecution } from "../src/core/execution/RetreatExecution";
import {
  PlayerType,
  type Attack,
  type Game,
  type Player,
} from "../src/core/game/Game";

function fixture() {
  const player = (id: number) =>
    ({
      id: () => `bot${id}`,
      smallID: () => id,
      type: () => PlayerType.Nation,
      isPlayer: () => true,
      isAlive: () => true,
      isFriendly: () => false,
      isTraitor: () => false,
      troops: () => 2000,
      numTilesOwned: () => 10,
      outgoingAttacks: () => [] as Attack[],
      incomingAttacks: () => [] as Attack[],
    }) as unknown as Player;
  const a = player(1),
    b = player(2),
    c = player(3);
  vi.spyOn(b, "troops").mockReturnValue(1000);
  vi.spyOn(c, "troops").mockReturnValue(1200);
  const config = { continuousPressure: "v1", pressureGraceSeconds: 0 };
  const game = {
    config: () => ({ gameConfig: () => config }),
    elapsedGameSeconds: () => 0,
    playerBySmallID: (id: number) => (id === 2 ? b : c),
    addExecution: vi.fn(),
  } as unknown as Game;
  const index = {
    get: () =>
      new Map([
        [2, 10],
        [3, 10],
      ]),
    width: () => 20,
  };
  return { a, b, c, game, index, config };
}

test("personalities are stable and offer distinct commitments", () => {
  expect(pressurePersonality("bot1")).toEqual(pressurePersonality("bot1"));
  expect(
    new Set(
      Array.from({ length: 30 }, (_, i) => pressurePersonality(`bot${i}`).name),
    ).size,
  ).toBe(4);
});

test("campaign targets a vulnerable neighbor, retains it after recovery and does not duplicate orders", () => {
  const { a, b, c, game, index } = fixture();
  expect(applyPressureStrategy(game, a, 0, index)).toBe(true);
  expect(vi.mocked(game.addExecution).mock.calls[0][0]).toBeInstanceOf(
    AttackExecution,
  );
  expect(
    (
      vi.mocked(game.addExecution).mock.calls[0][0] as AttackExecution
    ).targetID(),
  ).toBe(b.id());
  applyPressureStrategy(game, a, 1, index);
  expect(game.addExecution).toHaveBeenCalledTimes(1);
  applyPressureStrategy(game, a, 200, index); // completed campaign starts recovery
  expect(applyPressureStrategy(game, a, 201, index)).toBe(true);
  vi.spyOn(c, "troops").mockReturnValue(900); // slightly weaker, not worth abandoning objective
  applyPressureStrategy(game, a, 700, index);
  expect(
    (
      vi.mocked(game.addExecution).mock.calls[1][0] as AttackExecution
    ).targetID(),
  ).toBe(b.id());
});

test("losing a campaign without territorial progress orders a native retreat and recovery", () => {
  const { a, b, game, index } = fixture();
  applyPressureStrategy(game, a, 0, index);
  const attack = {
    id: () => "front",
    isActive: () => true,
    retreated: () => false,
    retreating: () => false,
    target: () => b,
    troops: () => 10,
  } as Attack;
  vi.spyOn(a, "outgoingAttacks").mockReturnValue([attack]);
  applyPressureStrategy(game, a, 200, index);
  expect(vi.mocked(game.addExecution).mock.calls[1][0]).toBeInstanceOf(
    RetreatExecution,
  );
  applyPressureStrategy(game, a, 201, index);
  expect(game.addExecution).toHaveBeenCalledTimes(2);
});

test("allies, grace, humans, tribes and endangered defenders do not launch campaigns", () => {
  for (const reason of ["allies", "grace", "human", "tribe", "defending"]) {
    const { a, b, game, index, config } = fixture();
    if (reason === "allies") vi.spyOn(a, "isFriendly").mockReturnValue(true);
    if (reason === "grace") config.pressureGraceSeconds = 180;
    if (reason === "human")
      vi.spyOn(a, "type").mockReturnValue(PlayerType.Human);
    if (reason === "tribe") vi.spyOn(a, "type").mockReturnValue(PlayerType.Bot);
    if (reason === "defending")
      vi.spyOn(a, "incomingAttacks").mockReturnValue([
        {
          isActive: () => true,
          retreating: () => false,
          attacker: () => b,
          troops: () => 1500,
        } as Attack,
      ]);
    applyPressureStrategy(game, a, 0, index);
    expect(game.addExecution).not.toHaveBeenCalled();
  }
});
