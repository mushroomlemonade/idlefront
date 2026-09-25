import {
  PlayerType,
  UnitType,
  type Game,
  type Gold,
  type Player,
} from "./Game";
import { mobilisePopulation } from "./PopulationMobilisation";

export interface PressureView {
  explicitIdle?: boolean;
  civilians: number;
  military: number;
  target: number;
  effectiveTarget: number;
  automatic: boolean;
  growthPerSecond?: number;
  autoDefenceEnabled?: boolean;
}
interface Population extends PressureView {
  lastManualTick: number;
  lastTick: number;
  conversionRemainder: number;
}
const populations = new WeakMap<Player, Population>();

export function pressurePopulation(game: Game, player: Player): Population {
  let state = populations.get(player);
  if (!state) {
    state = {
      civilians: player.troops(),
      military: player.troops(),
      target: 0.5,
      effectiveTarget: 0.5,
      automatic: false,
      lastManualTick: game.ticks(),
      lastTick: game.ticks(),
      conversionRemainder: 0,
    };
    populations.set(player, state);
  }
  return state;
}
export function pressureView(player: Player): PressureView | undefined {
  const s = populations.get(player);
  return (
    s && {
      civilians: Math.floor(s.civilians),
      explicitIdle: s.explicitIdle === true,
      military: Math.floor(player.troops() + deployedTroops(player)),
      target: s.target,
      effectiveTarget: s.effectiveTarget,
      automatic: s.automatic,
      growthPerSecond: s.growthPerSecond,
      autoDefenceEnabled: s.autoDefenceEnabled === true,
    }
  );
}

/** Strategy changes the desired ratio only; normal paced conversion moves people. */
export function setAiMobilisationTarget(player: Player, target: number): void {
  const state = populations.get(player);
  if (!state || player.type() !== PlayerType.Nation) return;
  state.target = Math.max(0.35, Math.min(0.8, target));
}
export function samePressure(a?: PressureView, b?: PressureView): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.civilians === b.civilians &&
      a.military === b.military &&
      a.target === b.target &&
      a.effectiveTarget === b.effectiveTarget &&
      a.growthPerSecond === b.growthPerSecond &&
      a.autoDefenceEnabled === b.autoDefenceEnabled &&
      a.explicitIdle === b.explicitIdle &&
      a.automatic === b.automatic)
  );
}
export function setMobilisationTarget(
  game: Game,
  player: Player,
  target: number,
  autoDefenceEnabled?: boolean,
): void {
  if (
    !game.config().gameConfig().continuousPressure ||
    !Number.isFinite(target) ||
    target < 0 ||
    target > 1
  )
    return;
  const s = pressurePopulation(game, player);
  if (autoDefenceEnabled !== undefined)
    s.autoDefenceEnabled = autoDefenceEnabled;
  s.target = target;
  s.effectiveTarget = target;
  s.lastManualTick = game.ticks();
  s.automatic = false;
  s.conversionRemainder = 0;
}
export function notePressureActivity(game: Game, player: Player): void {
  // Do not initialise population before spawn has supplied the starting army.
  const state = populations.get(player);
  if (state) {
    state.lastManualTick = game.ticks();
    state.explicitIdle = false;
  }
}
export function setExplicitIdle(
  game: Game,
  player: Player,
  idle: boolean,
): void {
  if (!game.config().gameConfig().continuousPressure || !player.isAlive())
    return;
  const state = pressurePopulation(game, player);
  state.explicitIdle = idle;
  if (!idle) state.lastManualTick = game.ticks();
}
/** Native attacks and transports already debit the free troop pool. */
export function deployedTroops(player: Player): number {
  let count = 0;
  for (const a of player.outgoingAttacks())
    if (a.isActive()) count += a.troops();
  for (const u of player.units(UnitType.TransportShip))
    if (u.isActive()) count += u.troops();
  return count;
}
export function updatePressurePopulation(game: Game, player: Player): void {
  const pace = game.config().gameConfig().pressurePacing;
  if (!pace) return;
  const s = pressurePopulation(game, player);
  const seconds = Math.max(0, game.ticks() - s.lastTick) / 10;
  s.lastTick = game.ticks();
  const committed = deployedTroops(player),
    military = player.troops() + committed;
  const population = s.civilians + military,
    cap = game.config().maxTroops(player);
  // Exact logistic growth; capacity limits growth, never deletes donations.
  const legacyGrown =
    population > 0 && population < cap
      ? cap /
        (1 +
          (cap / population - 1) *
            Math.exp((-Math.LN2 * seconds) / pace.populationDoublingSeconds))
      : population;
  // Native formula, same capacity and type/difficulty modifiers, 1:1 population.
  // Capacity limits births; it never destroys over-cap donations.
  const grown =
    pace.populationGrowthMultiplier === undefined
      ? legacyGrown
      : population +
        Math.min(
          Math.max(0, cap - population),
          Math.max(0, game.config().troopIncreaseRate(player, population)) *
            pace.populationGrowthMultiplier *
            seconds *
            10,
        );
  s.growthPerSecond = seconds > 0 ? (grown - population) / seconds : 0;
  s.civilians += grown - population;
  const automatic =
    s.explicitIdle === true ||
    player.type() !== PlayerType.Human ||
    s.autoDefenceEnabled === true ||
    player.isDisconnected() ||
    game.ticks() - s.lastManualTick >= 600;
  let target = s.target;
  if (automatic)
    for (const attack of player.incomingAttacks()) {
      const attacker = attack.attacker(),
        other = populations.get(attacker);
      if (other && !player.isFriendly(attacker)) {
        const army = attacker.troops() + deployedTroops(attacker);
        target = Math.max(target, army / Math.max(1, army + other.civilians));
      }
    }
  s.effectiveTarget = target;
  s.automatic = automatic && target > s.target;
  const result = mobilisePopulation(
    { civilians: s.civilians, troops: military, committedTroops: committed },
    target,
    seconds,
    pace.mobilisationHalfLifeSeconds,
  );
  const requested = result.troops - military + s.conversionRemainder;
  const transfer = Math.max(
    -player.troops(),
    Math.min(Math.floor(s.civilians), Math.trunc(requested)),
  );
  s.conversionRemainder = requested - transfer;
  const free = player.troops() + transfer;
  player.setTroops(free);
  s.military = free + committed;
  s.civilians = grown - s.military;
}
export function pressureIncome(player: Player, base: Gold): Gold {
  const s = populations.get(player);
  if (!s) return base;
  const total = s.civilians + player.troops() + deployedTroops(player);
  const bonus = total > 0 ? Math.floor((10000 * s.civilians) / total) : 0;
  return (base * BigInt(10000 + bonus)) / 10000n;
}
export function pressureHash(player: Player): number {
  const s = populations.get(player);
  return s
    ? Math.floor(s.civilians * 1000) +
        (s.explicitIdle ? 314187 : 0) +
        s.lastManualTick * 31 +
        Math.round(s.target * 10000) +
        s.lastTick * 17 +
        Math.round(s.conversionRemainder * 1000000) +
        (s.autoDefenceEnabled === false
          ? 104729
          : s.autoDefenceEnabled === true
            ? 209458
            : 0)
    : 0;
}
