import { PlayerType, type Game, type Player } from "../game/Game";
import { nationPersonality } from "../game/NationPersonality";
import { hasPressureGrace } from "../game/PressureDiplomacy";
import { setAiMobilisationTarget } from "../game/PressurePopulation";
import { AttackExecution } from "./AttackExecution";
import { RetreatExecution } from "./RetreatExecution";

export const pressurePersonality = nationPersonality;

interface Campaign {
  nextDecision: number;
  recoverUntil: number;
  target: number | null;
  expires: number;
  sent: number;
  tilesAtLaunch: number;
  launched: number;
  tracking: boolean;
}
interface FrontierIndex {
  get(player: Player): Map<number, number>;
  width(player: Player): number;
}
const campaigns = new WeakMap<Game, Map<number, Campaign>>();

/** Returns true while a campaign has spent the budget or the army is recovering.
 * Decisions read only existing neighboring fronts; no map or player-wide search.
 * Identity-based variation and tick timing keep replay decisions deterministic.
 */
export function applyPressureStrategy(
  game: Game,
  player: Player,
  tick: number,
  index: FrontierIndex,
): boolean {
  if (player.type() !== PlayerType.Nation) return false;
  let players = campaigns.get(game);
  if (!players) {
    players = new Map();
    campaigns.set(game, players);
  }
  const profile = pressurePersonality(player.id());
  let state = players.get(player.smallID());
  if (!state) {
    state = {
      nextDecision: tick,
      recoverUntil: 0,
      target: null,
      expires: 0,
      sent: 0,
      tilesAtLaunch: 0,
      launched: 0,
      tracking: false,
    };
    players.set(player.smallID(), state);
  }
  if (tick < state.recoverUntil) return true;
  if (tick < state.nextDecision) return false;
  state.nextDecision = tick + profile.interval;

  const active = player
    .outgoingAttacks()
    .filter((a) => a.isActive() && !a.retreated());
  const free = player.troops();
  const incoming = player
    .incomingAttacks()
    .filter(
      (a) =>
        a.isActive() && !a.retreating() && !player.isFriendly(a.attacker()),
    )
    .reduce((sum, a) => sum + a.troops(), 0);
  if (incoming > free * 0.25 || state.tracking)
    setAiMobilisationTarget(player, 0.75);
  if (state.tracking) {
    const attack = active.find((a) => a.target().smallID() === state!.target);
    const target = attack?.target();
    const lostWithoutProgress =
      !!attack &&
      attack.troops() < state.sent * 0.4 &&
      player.numTilesOwned() <= state.tilesAtLaunch;
    const protectedTarget =
      target?.isPlayer() &&
      (player.isFriendly(target) || hasPressureGrace(game, target));
    if (
      attack &&
      !attack.retreating() &&
      (lostWithoutProgress || protectedTarget || incoming > free * 0.8)
    ) {
      game.addExecution(new RetreatExecution(player, attack.id()));
      state.recoverUntil = tick + profile.recovery;
      state.tracking = false;
      state.target = null;
      setAiMobilisationTarget(player, incoming > free * 0.25 ? 0.75 : 0.45);
      return true;
    }
    if (attack) return false;
    // Wait until a queued execution has had time to create its attack.
    if (tick <= state.launched + 10) return true;
    state.tracking = false;
    state.recoverUntil = tick + profile.recovery;
    return true;
  }
  if (
    hasPressureGrace(game, player) ||
    active.length ||
    incoming > free * 0.35 ||
    free < 100
  )
    return false;

  const ownStrength = free / index.width(player);
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const [id, contact] of index.get(player)) {
    const target = game.playerBySmallID(id);
    if (
      !target.isPlayer() ||
      !target.isAlive() ||
      player.isFriendly(target) ||
      hasPressureGrace(game, target)
    )
      continue;
    const resistance = target.troops() / index.width(target);
    if (ownStrength < resistance * profile.tolerance) continue;
    // Favor a front already under pressure and retain a viable campaign rather
    // than switching targets on every small fluctuation in troop counts.
    const distracted = target
      .incomingAttacks()
      .some((a) => a.isActive() && !a.retreating() && a.attacker() !== player);
    const loyalty = state.target === id && tick < state.expires ? 1.5 : 1;
    const score =
      (ownStrength / Math.max(1, resistance)) *
      loyalty *
      (distracted ? 1.3 : 1) *
      (target.isTraitor() ? 1.2 : 1) *
      (1 + Math.min(contact, 100) / 500);
    if (score > bestScore) {
      best = target;
      bestScore = score;
    }
  }
  if (!best) {
    state.target = null;
    // Build an army to break an unfavorable land stalemate; peaceful, isolated
    // nations keep a larger civilian economy until naval planning mobilizes them.
    const hostile = [...index.get(player).keys()].some((id) => {
      const other = game.playerBySmallID(id);
      return (
        other.isPlayer() &&
        other.isAlive() &&
        !player.isFriendly(other) &&
        !hasPressureGrace(game, other)
      );
    });
    setAiMobilisationTarget(player, hostile ? 0.75 : 0.45);
    return false;
  }
  setAiMobilisationTarget(player, 0.75);
  const amount = Math.floor(
    Math.min(free * profile.commitment, Math.max(0, free - incoming * 1.5)),
  );
  if (amount < 20) return false;
  if (state.target !== best.smallID()) state.expires = tick + 1200;
  state.target = best.smallID();
  state.sent = amount;
  state.tilesAtLaunch = player.numTilesOwned();
  state.launched = tick;
  state.tracking = true;
  game.addExecution(new AttackExecution(amount, player, best.id(), null, true));
  return true;
}
