import { Game, Player, PlayerType, UnitType } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { nationPersonality } from "../../game/NationPersonality";
import { hasPressureGrace } from "../../game/PressureDiplomacy";
import {
  pressureView,
  setAiMobilisationTarget,
} from "../../game/PressurePopulation";
import { canBuildTransportShip } from "../../game/TransportShipUtils";
import { PseudoRandom } from "../../PseudoRandom";
import { simpleHash } from "../../Util";
import { BreakAllianceExecution } from "../alliance/BreakAllianceExecution";
import { AttackExecution } from "../AttackExecution";
import { ConstructionExecution } from "../ConstructionExecution";
import { configureNationFleet } from "../FleetAutomation";
import { MoveWarshipExecution } from "../MoveWarshipExecution";
import { navalPacingScale } from "../NavalPacing";
import { RetreatExecution } from "../RetreatExecution";
import { TransportShipExecution } from "../TransportShipExecution";

export type NationObjectiveKind =
  "develop" | "defend" | "expand" | "conquer" | "invade";
export interface NationPlan {
  kind: NationObjectiveKind;
  target: number | null;
  landing: TileRef | null;
  phase: "prepare" | "execute" | "consolidate";
  since: number;
  lastProgress: number;
  targetLand: number;
  score: number;
  reason: string;
}

export function usesNationStrategy(game: Game, player: Player): boolean {
  return (
    ["v1", "v2"].includes(game.config().gameConfig().nationStrategy ?? "") &&
    !!game.config().gameConfig().continuousPressure &&
    !game.config().gameConfig().fogOfWar &&
    player.type() === PlayerType.Nation
  );
}
const strategies = new WeakMap<Game, Map<number, NationStrategy>>();
// Incrementally discover static coastlines; never scan a whole map in one tick.
const coasts = new WeakMap<Game, { cursor: number; tiles: TileRef[] }>();
function coastalCandidates(game: Game): TileRef[] {
  let index = coasts.get(game);
  if (!index) coasts.set(game, (index = { cursor: 0, tiles: [] }));
  const end = Math.min(game.width() * game.height(), index.cursor + 256);
  for (; index.cursor < end; index.cursor++) {
    const tile = game.ref(
      index.cursor % game.width(),
      Math.floor(index.cursor / game.width()),
    );
    if (game.isLand(tile) && game.isShore(tile) && !game.isImpassable(tile))
      index.tiles.push(tile);
  }
  return index.tiles;
}
export function nationStrategy(game: Game, player: Player): NationStrategy {
  let states = strategies.get(game);
  if (!states) strategies.set(game, (states = new Map()));
  let state = states.get(player.smallID());
  if (!state)
    states.set(player.smallID(), (state = new NationStrategy(game, player)));
  return state;
}

/** Pure utility estimate, not a prediction of the combat formula. */
export function conquestValue(
  land: number,
  assets: number,
  resistance: number,
  available: number,
  distance: number,
  committed: boolean,
  distracted: boolean,
): number {
  const strength = Math.min(3, available / Math.max(100, resistance));
  return (
    ((1 + Math.log1p(land) / 5 + Math.min(assets, 30) / 8) *
      strength *
      (committed ? 1.4 : 1) *
      (distracted ? 1.2 : 1)) /
    (1 + distance / 350)
  );
}

/** One bounded, deterministic planner for each nation. All effects go through
 * native executions. State is reconstructed by the match's versioned replay. */
export class NationStrategy {
  readonly plan: NationPlan = {
    kind: "develop",
    target: null,
    landing: null,
    phase: "prepare",
    since: 0,
    lastProgress: 0,
    targetLand: 0,
    score: 0,
    reason: "developing economy",
  };
  private nextDecision = 0;
  private nextFleetDecision = 0;
  private nextAttack = 0;
  private cursor = 0;
  private waves = 0;
  private failedTarget: number | null = null;
  private failedUntil = 0;
  private lastSent = 0;
  private landAtAttack = 0;
  private random: PseudoRandom;
  goldReserve = 0n;
  fleetTarget = 0;
  private strikeTarget: number | null = null;
  private strikeUntil = 0;

  private get improved(): boolean {
    return this.game.config().gameConfig().nationStrategy === "v2";
  }

  /** A paid nuclear launch creates a conquest opportunity, not a free attack. */
  noteStrike(target: Player): void {
    if (!this.improved || !this.legal(target)) return;
    this.strikeTarget = target.smallID();
    this.strikeUntil = this.game.ticks() + 1800 * navalPacingScale(this.game);
    this.nextDecision = 0;
    this.nextAttack = 0;
    this.failedTarget = null;
    this.clear();
  }

  constructor(
    private game: Game,
    private player: Player,
  ) {
    this.random = new PseudoRandom(simpleHash(player.id()) ^ 263091);
  }

  private legal(target: Player): boolean {
    return (
      target !== this.player &&
      target.isAlive() &&
      !this.player.isFriendly(target) &&
      !hasPressureGrace(this.game, target) &&
      this.player.canAttackPlayer(target)
    );
  }

  /** Nations must not ally away their chosen war, the final opponent, or a
   * runaway rival. Expiry still never bypasses the native protection timer. */
  usefulAlly(other: Player): boolean {
    if (this.plan.target === other.smallID()) return false;
    const rivals = this.game
      .players()
      .filter(
        (p) =>
          p !== this.player &&
          p.isAlive() &&
          p.type() !== PlayerType.Bot &&
          !this.player.isOnSameTeam(p),
      );
    return (
      rivals.length > 1 &&
      !(
        other.numTilesOwned() > this.player.numTilesOwned() * 1.5 &&
        other.numTilesOwned() > this.game.numLandTiles() * 0.3
      )
    );
  }

  tick(): void {
    const g = this.game,
      p = this.player,
      tick = g.ticks();
    if (!usesNationStrategy(g, p) || !p.isAlive() || g.inSpawnPhase()) return;
    if (tick < this.nextDecision) return;
    const pace = navalPacingScale(g);
    this.nextDecision =
      tick + Math.ceil(((this.improved ? 20 : 40) + (p.smallID() % 20)) * pace);
    const free = p.troops();
    const incoming = p
      .incomingAttacks()
      .filter(
        (a) => a.isActive() && !a.retreating() && !p.isFriendly(a.attacker()),
      )
      .reduce((sum, a) => sum + a.troops(), 0);
    const neighbors = p.nearby();
    const landEnemies = neighbors.filter(
      (n): n is Player => n.isPlayer() && this.legal(n),
    );
    const existing =
      this.plan.target === null ? null : g.playerBySmallID(this.plan.target);
    const travelling = p
      .units(UnitType.TransportShip)
      .some(
        (s) =>
          s.isActive() &&
          !s.transportShipState().isRetreating &&
          s.targetTile() === this.plan.landing,
      );
    if (
      existing?.isPlayer() &&
      existing.numTilesOwned() < this.plan.targetLand
    ) {
      this.plan.lastProgress = tick;
      this.plan.targetLand = existing.numTilesOwned();
      this.waves = 0;
    }
    const stalled =
      existing?.isPlayer() &&
      !travelling &&
      tick - this.plan.lastProgress > 1200 * pace;
    if (stalled) {
      this.failedTarget = existing.smallID();
      this.failedUntil = tick + 600 * pace;
    }
    if (existing?.isPlayer() && (!this.legal(existing) || stalled))
      this.clear();
    if (incoming > free * 0.55) {
      this.choose(
        "defend",
        null,
        null,
        0,
        "reserving troops against incoming attacks",
      );
      setAiMobilisationTarget(p, 0.8);
    } else {
      let best: Player | null = null,
        score = 0;
      for (const target of landEnemies.slice(0, 24)) {
        if (target.smallID() === this.failedTarget && tick < this.failedUntil)
          continue;
        const value = this.score(target, 0);
        if (value > score) {
          best = target;
          score = value;
        }
      }
      // Preserve a live overseas campaign unless an urgent home opportunity
      // is substantially better. Landing immediately becomes a land campaign.
      if (
        best &&
        (this.plan.kind !== "invade" ||
          !travelling ||
          score > this.plan.score * 2)
      ) {
        this.choose(
          "conquer",
          best,
          null,
          score,
          "concentrating on a valuable, beatable neighbor",
        );
      } else if (this.plan.target === null || this.plan.kind === "defend") {
        this.clear();
        if (!hasPressureGrace(g, p)) this.findOverseas();
      }
      const hostile = landEnemies.length > 0 || this.plan.target !== null;
      setAiMobilisationTarget(p, hostile ? 0.75 : 0.45);
    }
    // Price a useful fleet rather than hoarding a fixed fraction forever.
    const ports = p
      .units(UnitType.Port)
      .filter((u) => u.isActive() && !u.isUnderConstruction());
    const warshipCost = g.unitInfo(UnitType.Warship).cost(g, p);
    this.fleetTarget =
      ports.length && !g.config().isUnitDisabled(UnitType.Warship)
        ? Math.min(
            8,
            Math.max(
              this.plan.kind === "invade" ? 2 : 1,
              Math.ceil(ports.length / 3),
            ),
          )
        : 0;
    this.goldReserve =
      p.unitCount(UnitType.Warship) < this.fleetTarget ? warshipCost : 0n;
    // Frequent infrastructure purchases must not starve the native nuke AI.
    if (
      this.plan.target !== null &&
      p.unitCount(UnitType.MissileSilo) > 0 &&
      p.unitCount(UnitType.City) >= 3 &&
      !g.config().isUnitDisabled(UnitType.AtomBomb)
    ) {
      this.goldReserve += g.unitInfo(UnitType.AtomBomb).cost(g, p);
    }
    this.manageFleet(ports.map((u) => u.tile()));
    if (this.improved && g.config().gameConfig().fleetAutomation) {
      // Additional standing replenishment; native reactive spawning above remains.
      // Limit the force by both economy and useful port coverage, not infinite gold.
      const affordable = Number(p.gold() / (warshipCost || 1n));
      const target = ports.length
        ? Math.min(
            48,
            Math.max(
              this.fleetTarget,
              Math.min(ports.length * 3, Math.floor(affordable * 0.25)),
            ),
          )
        : 0;
      configureNationFleet(g, p, {
        enabled: true,
        automaticPorts: true,
        ports: [],
        target,
        reserve: Number(this.goldReserve),
        order: this.plan.kind === "invade" ? "escort" : "defend",
      });
    }
    this.act(
      landEnemies,
      neighbors.some((n) => !n.isPlayer()),
      incoming,
    );
    this.considerEndgameDiplomacy();
  }

  private score(target: Player, distance: number): number {
    const available = this.player.troops();
    // Avoid suicidal wars, but recognise an enemy whose army is already away.
    if (available < target.troops() * 0.65 || available < 100) return 0;
    const assets =
      target.unitCount(UnitType.City) * 2 +
      target.unitCount(UnitType.Factory) * 2 +
      target.unitCount(UnitType.Port) +
      target.unitCount(UnitType.MissileSilo);
    const distracted = target
      .outgoingAttacks()
      .some((a) => a.isActive() && !a.retreating());
    const leaderPressure =
      target.numTilesOwned() > this.game.numLandTiles() * 0.3 ? 1.15 : 1;
    return (
      conquestValue(
        target.numTilesOwned(),
        assets,
        target.troops(),
        available,
        distance,
        target.smallID() === this.plan.target,
        distracted,
      ) *
      leaderPressure *
      (this.improved
        ? (1 +
            Math.min(
              3,
              Math.max(0, available / Math.max(100, target.troops()) - 3) / 3,
            )) *
          (this.strikeTarget === target.smallID() &&
          this.game.ticks() < this.strikeUntil
            ? 4
            : 1)
        : 1)
    );
  }

  private choose(
    kind: NationObjectiveKind,
    target: Player | null,
    landing: TileRef | null,
    score: number,
    reason: string,
  ): void {
    const id = target?.smallID() ?? null;
    if (id !== this.plan.target || kind !== this.plan.kind) {
      this.plan.since = this.game.ticks();
      this.plan.lastProgress = this.game.ticks();
      this.plan.targetLand = target?.numTilesOwned() ?? 0;
      this.waves = 0;
    }
    Object.assign(this.plan, { kind, target: id, landing, score, reason });
  }
  private clear(): void {
    this.choose(
      "develop",
      null,
      null,
      0,
      "building economy while seeking favorable expansion",
    );
    this.plan.phase = "prepare";
  }

  private findOverseas(): void {
    const g = this.game,
      p = this.player;
    if (g.config().isUnitDisabled(UnitType.TransportShip) || p.troops() < 1000)
      return;
    const roster = g.players();
    const shores = this.improved ? coastalCandidates(g) : [];
    if (!roster.length) return;
    const candidates: { target: Player; tile: TileRef; score: number }[] = [];
    const origin = p.units(UnitType.Port)[0]?.tile() ?? p.spawnTile();
    for (let i = 0; i < Math.min(12, roster.length); i++) {
      const strike =
        this.improved &&
        g.ticks() < this.strikeUntil &&
        this.strikeTarget !== null
          ? g.playerBySmallID(this.strikeTarget)
          : null;
      const target =
        i === 0 && strike?.isPlayer()
          ? strike
          : roster[(this.cursor + i) % roster.length];
      if (
        !this.legal(target) ||
        (target.smallID() === this.failedTarget && g.ticks() < this.failedUntil)
      )
        continue;
      let tile = target.units(UnitType.Port)[0]?.tile();
      if (tile === undefined) {
        let examined = 0;
        for (const border of target.borderTiles()) {
          if (++examined > 128) break;
          if (g.isShore(border)) {
            tile = border;
            break;
          }
        }
      }
      if (tile === undefined) continue;
      const score = this.score(
        target,
        origin === undefined ? 0 : g.manhattanDist(origin, tile),
      );
      if (score > 0) candidates.push({ target, tile, score });
    }
    this.cursor = (this.cursor + 12) % roster.length;
    candidates.sort(
      (a, b) => b.score - a.score || a.target.smallID() - b.target.smallID(),
    );
    // Pathfinding is the expensive step: two queries per decision at most.
    let queries = 0;
    for (const candidate of candidates.slice(0, 2)) {
      queries++;
      if (canBuildTransportShip(g, p, candidate.tile) === false) continue;
      this.choose(
        "invade",
        candidate.target,
        candidate.tile,
        candidate.score,
        "preparing a persistent overseas conquest",
      );
      return;
    }
    // Unoccupied islands are useful too. Share the same two-query budget;
    // never scan the world or launch a second exploratory boat while one sails.
    if (p.unitCount(UnitType.TransportShip) > 0) return;
    for (let i = 0; i < 48 && queries < 2; i++) {
      const tile =
        this.improved && shores.length
          ? shores[this.random.nextInt(0, shores.length)]
          : g.ref(
              this.random.nextInt(0, g.width()),
              this.random.nextInt(0, g.height()),
            );
      if (
        g.hasOwner(tile) ||
        !g.isLand(tile) ||
        !g.isShore(tile) ||
        g.isImpassable(tile)
      )
        continue;
      queries++;
      if (canBuildTransportShip(g, p, tile) === false) continue;
      g.addExecution(
        new TransportShipExecution(p, tile, Math.floor(p.troops() * 0.15)),
      );
      this.plan.reason = "establishing an unoccupied overseas foothold";
      this.nextAttack = g.ticks() + 150 * navalPacingScale(g);
      return;
    }
  }

  private act(
    landEnemies: Player[],
    wilderness: boolean,
    incoming: number,
  ): void {
    const g = this.game,
      p = this.player,
      tick = g.ticks(),
      pace = navalPacingScale(g);
    if (tick < this.nextAttack) return;
    const free = p.troops(),
      active = p
        .outgoingAttacks()
        .filter((a) => a.isActive() && !a.retreating());
    if (this.plan.kind === "defend") {
      // Recover a committed army through the normal, lossy retreat mechanism.
      const front = active.find((a) => a.target().isPlayer());
      if (front && incoming > free * 0.8)
        g.addExecution(new RetreatExecution(p, front.id()));
      return;
    }
    // Continue cheap expansion during wars instead of conceding all empty land.
    let expanding = false;
    if (
      wilderness &&
      incoming < free * 0.2 &&
      free >= 100 &&
      !active.some(
        (a) =>
          !a.target().isPlayer() &&
          (!this.improved || a.troops() >= free * 0.08),
      )
    ) {
      g.addExecution(
        new AttackExecution(
          Math.floor(
            free * (this.improved && !landEnemies.length ? 0.25 : 0.12),
          ),
          p,
          null,
          null,
          true,
          g.config().gameConfig().passiveWildernessExpansion === true,
        ),
      );
      expanding = true;
    }
    const target =
      this.plan.target === null ? null : g.playerBySmallID(this.plan.target);
    if (target?.isPlayer() && this.legal(target)) {
      const profile = nationPersonality(p.id());
      const amount = Math.floor(
        Math.min(free * (profile.commitment + 0.12), free - incoming * 1.5),
      );
      if (amount < 100) return;
      if (landEnemies.includes(target)) {
        const front = active.find((a) => a.target() === target);
        if (
          front &&
          front.troops() < this.lastSent * 0.35 &&
          p.numTilesOwned() <= this.landAtAttack
        ) {
          g.addExecution(new RetreatExecution(p, front.id()));
          this.failedTarget = target.smallID();
          this.failedUntil = tick + 600 * pace;
          this.clear();
          this.nextAttack = tick + 200 * pace;
          return;
        }
        // Reinforce a progressing front when its committed force has thinned.
        if (front && front.troops() > amount * 0.75) return;
        if (
          active.some(
            (a) =>
              a.target().isPlayer() &&
              a.target() !== target &&
              (!this.improved || a.troops() > free * 0.15),
          )
        )
          return;
        g.addExecution(new AttackExecution(amount, p, target.id()));
        this.lastSent = amount + (front?.troops() ?? 0);
        this.landAtAttack = p.numTilesOwned();
        this.plan.phase = front ? "consolidate" : "execute";
        this.nextAttack = tick + 100 * pace;
        return;
      }
      if (
        this.plan.kind === "invade" &&
        this.plan.landing !== null &&
        p.unitCount(UnitType.TransportShip) <
          Math.min(2, g.config().boatMaxNumber())
      ) {
        // A hostile navy warrants escorts, but do not wait forever at a closed port.
        const escortCount = p
          .units(UnitType.Warship)
          .filter((s) => s.isActive() && !s.isUnderConstruction()).length;
        if (
          target.unitCount(UnitType.Warship) > 0 &&
          escortCount < 2 &&
          tick - this.plan.since < 300 * pace &&
          !g.config().isUnitDisabled(UnitType.Warship)
        )
          return;
        if (g.owner(this.plan.landing) !== target) {
          this.clear();
          return;
        }
        if (this.waves >= 3) return; // Wait for progress or the stall timeout.
        g.addExecution(
          new TransportShipExecution(p, this.plan.landing, amount),
        );
        this.waves++;
        this.plan.phase = "execute";
        this.nextAttack = tick + 150 * pace;
        return;
      }
    }
    if (expanding) {
      if (this.plan.target === null) this.plan.kind = "expand";
      this.nextAttack = tick + 80 * pace;
    }
  }

  private manageFleet(ports: TileRef[]): void {
    const g = this.game,
      p = this.player;
    const ships = p.units(UnitType.Warship);
    const transport = p
      .units(UnitType.TransportShip)
      .find((s) => s.isActive() && !s.transportShipState().isRetreating);
    const patrol = transport?.tile();
    if (patrol !== undefined && g.isWater(patrol)) {
      const escorts = ships
        .filter(
          (s) =>
            s.isActive() &&
            !s.isUnderConstruction() &&
            g.hasWaterComponent(s.tile(), g.getWaterComponent(patrol)!),
        )
        .sort(
          (a, b) =>
            g.manhattanDist(a.tile(), patrol) -
            g.manhattanDist(b.tile(), patrol),
        )
        .slice(0, 2);
      if (escorts.length)
        g.addExecution(
          new MoveWarshipExecution(
            p,
            escorts.map((s) => s.id()),
            patrol,
            false,
          ),
        );
    }
    if (
      g.ticks() < this.nextFleetDecision ||
      ships.length >= this.fleetTarget ||
      !ports.length
    )
      return;
    this.nextFleetDecision = g.ticks() + 80 * navalPacingScale(g);
    if (p.gold() < g.unitInfo(UnitType.Warship).cost(g, p)) return;
    const port = ports[this.random.nextInt(0, ports.length)];
    // Native canBuild selects a legal port; sample close water, not a random ocean.
    for (let i = 0; i < 24; i++) {
      const x = g.x(port) + this.random.nextInt(-30, 31);
      const y = g.y(port) + this.random.nextInt(-30, 31);
      if (!g.isValidCoord(x, y)) continue;
      const tile = g.ref(x, y);
      if (!g.isWater(tile) || p.canBuild(UnitType.Warship, tile) === false)
        continue;
      g.addExecution(new ConstructionExecution(p, UnitType.Warship, tile));
      return;
    }
  }

  preferredStructures(coastal: boolean): UnitType[] {
    const p = this.player,
      population = pressureView(p);
    const nearCap =
      population &&
      population.civilians + population.military >
        this.game.config().maxTroops(p) * 0.75;
    const order: UnitType[] = [];
    if (nearCap || !p.unitCount(UnitType.City)) order.push(UnitType.City);
    if (coastal && !p.unitCount(UnitType.Port)) order.push(UnitType.Port);
    if (!p.unitCount(UnitType.Factory) && p.unitCount(UnitType.City) >= 2)
      order.push(UnitType.Factory);
    return order;
  }

  private considerEndgameDiplomacy(): void {
    if (this.plan.kind === "defend" || hasPressureGrace(this.game, this.player))
      return;
    const rivals = this.game
      .players()
      .filter(
        (p) =>
          p !== this.player &&
          p.isAlive() &&
          p.type() !== PlayerType.Bot &&
          !this.player.isOnSameTeam(p),
      );
    if (rivals.length !== 1) return;
    const alliance = this.player.allianceWith(rivals[0]);
    if (alliance && alliance.expiresAt() <= this.game.ticks())
      this.game.addExecution(
        new BreakAllianceExecution(this.player, rivals[0].id()),
      );
  }
}
