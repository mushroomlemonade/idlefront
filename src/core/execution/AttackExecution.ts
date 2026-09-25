import { renderTroops } from "../../client/Utils";
import { Config } from "../configuration/Config";
import { AttackImpl } from "../game/AttackImpl";
import {
  Attack,
  Difficulty,
  Execution,
  Game,
  MessageType,
  Player,
  PlayerID,
  PlayerType,
  TerrainType,
  TerraNullius,
} from "../game/Game";
import { GameMap, TileRef } from "../game/GameMap";
import { PseudoRandom } from "../PseudoRandom";
import { assertNever } from "../Util";
import { significantDiplomaticPush } from "./nation/NationOpportunity";
import type { WildernessAttackPlan } from "./planning/WildernessAttackPlanner";
import type { WildernessAttackInput } from "./planning/WildernessAttackState";
import { FlatBinaryHeap } from "./utils/FlatBinaryHeap"; // adjust path if needed

const malusForRetreat = 25;
// Keep passive and manual forces separate when attacks are merged. Replay
// reconstructs this classification from authoritative execution creation.
const passiveWildernessAttacks = new WeakSet<Attack>();
export class AttackExecution implements Execution {
  private active: boolean = true;
  // init/tick own every heap/PRNG mutation; the attack separately versions its
  // externally mutable troops, retreat flags and border set.
  private executionVersion = 0;
  private toConquer = new FlatBinaryHeap();

  private random = new PseudoRandom(123);

  private target: Player | TerraNullius;

  private mg: Game;
  // Direct GameMap reference to skip the Game delegation hop in hot loops.
  private map: GameMap;

  private attack: Attack | null = null;

  // Cached smallIDs for integer owner comparisons in hot loops.
  private ownerSmallID: number;
  private targetSmallID: number;
  // Reusable neighbor buffers to avoid closures/allocation in hot loops.
  private nbuf: TileRef[] = [0, 0, 0, 0];
  private nbuf2: TileRef[] = [0, 0, 0, 0];

  constructor(
    private startTroops: number | null = null,
    private _owner: Player,
    private _targetID: PlayerID | null,
    private sourceTile: TileRef | null = null,
    private removeTroops: boolean = true,
    private passiveWilderness: boolean = false,
  ) {}

  public targetID(): PlayerID | null {
    return this._targetID;
  }

  /** Read-only, opt-in planning checkpoint. Existing tick execution does not
   * call this. Unsupported policy/configuration paths remain authoritative.
   */
  wildernessPlanningInput(tick: number): WildernessAttackInput | null {
    if (
      !this.active ||
      !this.target ||
      this.target.isPlayer() ||
      !(this.attack instanceof AttackImpl) ||
      !this.attack.isActive() ||
      this.attack.retreated() ||
      this.attack.retreating() ||
      this.mg.hasAttackActivityPolicy?.() !== false
    )
      return null;
    const config = this.mg.config();
    if (
      Object.getPrototypeOf(config) !== Config.prototype ||
      config.gameConfig().fogOfWar ||
      config.attackLogic !== Config.prototype.attackLogic ||
      config.attackTilesPerTick !== Config.prototype.attackTilesPerTick ||
      config.falloutDefenseModifier !== Config.prototype.falloutDefenseModifier
    )
      return null;
    return {
      state: {
        attackID: this.attack.id(),
        ownerSmallID: this.ownerSmallID,
        ownerType: this._owner.type(),
        troops: this.attack.troops(),
        passiveWilderness: this.passiveWilderness,
        border: this.attack.borderSnapshot(),
        random: this.random.snapshot(),
        heap: this.toConquer.snapshot(),
      },
      map: this.map,
      config,
      tick: this.mg.ticks(),
      executionTick: tick,
    };
  }

  /** Authority-local guard, never sent to workers. Checks no heap/border arrays.
   * A caller still needs coherent tile revisions and must validate immediately
   * before applying a plan at this execution's original position.
   */
  wildernessPlanningCheckpoint(tick: number): {
    execution: AttackExecution;
    input: WildernessAttackInput;
    unchanged: (executionTick: number) => boolean;
  } | null {
    const input = this.wildernessPlanningInput(tick);
    if (!input) return null;
    const attack = this.attack as AttackImpl;
    const attackVersion = attack.planningVersion();
    const executionVersion = this.executionVersion;
    if (
      !Number.isSafeInteger(attackVersion) ||
      !Number.isSafeInteger(executionVersion)
    )
      return null;
    const config = input.config;
    const configJSON = JSON.stringify(config.gameConfig());
    const logic = config.attackLogic,
      pace = config.attackTilesPerTick,
      falloutModifier = config.falloutDefenseModifier;
    const land = this.map.numLandTiles(),
      fallout = this.map.numTilesWithFallout();
    return {
      execution: this,
      input,
      unchanged: (executionTick) =>
        executionTick === input.executionTick &&
        this.mg.ticks() === input.tick &&
        this.active &&
        this.executionVersion === executionVersion &&
        this.attack === attack &&
        attack.planningVersion() === attackVersion &&
        attack.isActive() &&
        !attack.retreating() &&
        !attack.retreated() &&
        this.ownerSmallID === input.state.ownerSmallID &&
        this._owner.type() === input.state.ownerType &&
        this.map === input.map &&
        this.mg.config() === config &&
        this.mg.hasAttackActivityPolicy?.() === false &&
        config.attackLogic === logic &&
        config.attackTilesPerTick === pace &&
        config.falloutDefenseModifier === falloutModifier &&
        this.map.numLandTiles() === land &&
        this.map.numTilesWithFallout() === fallout &&
        JSON.stringify(config.gameConfig()) === configJSON,
    };
  }

  /** Internal authority API. Caller supplies coherent world-dependency
   * validation, never a client callback. Currently exercised by replay tools
   * only. Heap/PRNG checkpoints are private planning state; ordinary observers
   * still see the original ordered border/troop/conquest effects.
   */
  tryApplyWildernessPlan(
    checkpoint: NonNullable<
      ReturnType<AttackExecution["wildernessPlanningCheckpoint"]>
    >,
    plan: WildernessAttackPlan,
    tick: number,
    tilesUnchanged: () => boolean,
  ): boolean {
    if (
      checkpoint.execution !== this ||
      plan.kind !== "shadow-plan" ||
      !checkpoint.unchanged(tick) ||
      !tilesUnchanged() ||
      plan.state.attackID !== checkpoint.input.state.attackID ||
      plan.state.ownerSmallID !== this.ownerSmallID ||
      plan.state.ownerType !== this._owner.type()
    )
      return false;
    // Validate/allocate the replacement buffers BEFORE any authoritative write.
    let heap: FlatBinaryHeap, random: PseudoRandom;
    try {
      heap = FlatBinaryHeap.fromSnapshot(plan.state.heap);
      random = PseudoRandom.fromSnapshot(plan.state.random);
    } catch {
      return false;
    }
    for (const effect of plan.effects) {
      if (effect.type === "troops") {
        if (!Number.isFinite(effect.troops) || effect.troops < 0) return false;
      } else if (
        !(
          effect.type === "border-add" ||
          effect.type === "border-remove" ||
          effect.type === "conquer"
        ) ||
        !this.map.isValidRef(effect.tile)
      )
        return false;
    }
    this.executionVersion++;
    for (const effect of plan.effects) {
      switch (effect.type) {
        case "border-add":
          this.attack!.addBorderTile(effect.tile);
          break;
        case "border-remove":
          this.attack!.removeBorderTile(effect.tile);
          break;
        case "troops":
          this.attack!.setTroops(effect.troops);
          break;
        case "conquer":
          this._owner.conquer(effect.tile);
          break;
      }
    }
    this.toConquer = heap;
    this.random = random;
    return true;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number) {
    this.executionVersion++;
    if (!this.active) {
      return;
    }
    this.mg = mg;
    this.map = mg.map();

    if (this._targetID !== null && !mg.hasPlayer(this._targetID)) {
      console.warn(`target ${this._targetID} not found`);
      this.active = false;
      return;
    }

    this.target =
      this._targetID === this.mg.terraNullius().id()
        ? mg.terraNullius()
        : mg.player(this._targetID);
    this.ownerSmallID = this._owner.smallID();
    this.passiveWilderness =
      this.passiveWilderness &&
      !this.target.isPlayer() &&
      !!this.mg.config().gameConfig().continuousPressure &&
      this.mg.config().gameConfig().passiveWildernessExpansion === true;
    this.targetSmallID = this.target.smallID();

    if (this._owner === this.target) {
      console.error(`Player ${this._owner} cannot attack itself`);
      this.active = false;
      return;
    }

    // ALLIANCE CHECK — block attacks on friendly (ally or same team)
    if (this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (this._owner.isFriendly(targetPlayer)) {
        console.warn(
          `${this._owner.displayName()} cannot attack ${targetPlayer.displayName()} because they are friendly (allied or same team)`,
        );
        this.active = false;
        return;
      }
    }

    const diplomaticPush = significantDiplomaticPush(
      this.mg,
      this.target,
      Math.min(
        this.removeTroops ? this._owner.troops() : Infinity,
        this.startTroops ??
          this.mg.config().attackAmount(this._owner, this.target),
      ),
    );
    if (diplomaticPush && this.target && this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (
        targetPlayer.type() !== PlayerType.Bot &&
        this._owner.type() !== PlayerType.Bot
      ) {
        // Don't let bots embargo since they can't trade anyway.
        targetPlayer.addEmbargo(this._owner, true);
        this.rejectIncomingAllianceRequests(targetPlayer);
      }
    }

    if (this.target.isPlayer() && !this._owner.canAttackPlayer(this.target)) {
      this.active = false;
      return;
    }

    this.startTroops ??= this.mg
      .config()
      .attackAmount(this._owner, this.target);
    if (this.removeTroops) {
      this.startTroops = Math.min(this._owner.troops(), this.startTroops);
      this._owner.removeTroops(this.startTroops);
    }
    this.attack = this._owner.createAttack(
      this.target,
      this.startTroops,
      this.sourceTile,
      new Set<TileRef>(),
    );
    if (this.passiveWilderness) passiveWildernessAttacks.add(this.attack);

    if (this.sourceTile !== null) {
      this.addNeighbors(this.sourceTile);
    } else {
      this.refreshToConquer();
    }

    // Record stats
    this.mg.stats().attack(this._owner, this.target, this.startTroops);

    for (const incoming of this._owner.incomingAttacks()) {
      if (incoming.attacker() === this.target) {
        // Target has opposing attack, cancel them out
        if (incoming.troops() > this.attack.troops()) {
          incoming.setTroops(incoming.troops() - this.attack.troops());
          this.attack.delete();
          this.active = false;
          return;
        } else {
          this.attack.setTroops(this.attack.troops() - incoming.troops());
          incoming.delete();
        }
      }
    }
    for (const outgoing of this._owner.outgoingAttacks()) {
      if (
        outgoing !== this.attack &&
        outgoing.target() === this.attack.target() &&
        passiveWildernessAttacks.has(outgoing) === this.passiveWilderness &&
        // Boat attacks (sourceTile is not null) are not combined with other attacks
        this.attack.sourceTile() === null
      ) {
        this.attack.setTroops(this.attack.troops() + outgoing.troops());
        outgoing.delete();
      }
    }

    if (diplomaticPush && this.target.isPlayer()) {
      const difficulty = this.mg.config().gameConfig().difficulty;
      let relationChange: number;
      switch (difficulty) {
        case Difficulty.Easy:
          relationChange = -60;
          break;
        case Difficulty.Medium:
          relationChange = -70;
          break;
        case Difficulty.Hard:
          relationChange = -80;
          break;
        case Difficulty.Impossible:
          relationChange = -100;
          break;
        default:
          assertNever(difficulty);
      }
      this.target.updateRelation(this._owner, relationChange);
    }
  }

  private refreshToConquer() {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    this.toConquer.clear();
    this.attack.clearBorder();
    for (const tile of this._owner.borderTiles()) {
      this.addNeighbors(tile);
    }
  }

  private retreat(malusPercent = 0) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const deaths = this.attack.troops() * (malusPercent / 100);
    if (deaths) {
      this.mg.displayMessage(
        "events_display.attack_cancelled_retreat",
        MessageType.ATTACK_CANCELLED,
        this._owner.id(),
        undefined,
        { troops: renderTroops(deaths) },
      );
    }
    if (this.removeTroops === false && this.sourceTile === null) {
      // startTroops are always added to attack troops at init but not always removed from owner troops
      // subtract startTroops from attack troops so we don't give back startTroops to owner that were never removed
      // boat attacks (sourceTile !== null) are the exception: troops were removed at departure and must be returned after attack still
      this.attack.setTroops(this.attack.troops() - (this.startTroops ?? 0));
    }

    const survivors = this.attack.troops() - deaths;
    this._owner.addTroops(survivors);
    this.attack.delete();
    this.active = false;

    // Not all retreats are canceled attacks
    if (this.attack.retreated()) {
      // Record stats
      this.mg.stats().attackCancel(this._owner, this.target, survivors);
    }
  }

  tick(ticks: number) {
    this.executionVersion++;
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }
    let troopCount = this.attack.troops(); // cache troop count
    const targetIsPlayer = this.target.isPlayer(); // cache target type
    const targetPlayer = targetIsPlayer ? (this.target as Player) : null; // cache target player

    if (this.attack.retreated()) {
      if (targetIsPlayer) {
        this.retreat(malusForRetreat);
      } else {
        this.retreat();
      }
      this.active = false;
      return;
    }

    if (this.attack.retreating()) {
      return;
    }

    if (!this.attack.isActive()) {
      this.active = false;
      return;
    }

    if (targetPlayer && this._owner.isFriendly(targetPlayer)) {
      // In this case a new alliance was created AFTER the attack started.
      this.retreat();
      return;
    }

    // Keep cancellation, death and diplomacy responsive on every tick. Only
    // the expensive remote bot frontier expansion may use the fog scheduler.
    // Never accumulate skipped work into a burst when a human approaches.
    const expansionBudget = this.mg.attackExpansionBudget(
      this._owner,
      this.target,
      ticks,
    );
    if (expansionBudget <= 0) return;

    let numTilesPerTick = this.mg
      .config()
      .attackTilesPerTick(
        troopCount,
        this._owner,
        this.target,
        this.attack.borderSize() + this.random.nextInt(0, 5),
      );

    numTilesPerTick = Math.min(numTilesPerTick, expansionBudget);

    while (numTilesPerTick > 0) {
      if (troopCount < 1) {
        this.attack.delete();
        this.active = false;
        return;
      }

      if (this.toConquer.size() === 0) {
        this.refreshToConquer();
        this.retreat();
        return;
      }

      const tileToConquer = this.toConquer.dequeue();
      this.attack.removeBorderTile(tileToConquer);

      let onBorder = false;
      const numNeighbors = this.map.neighbors4(tileToConquer, this.nbuf);
      for (let i = 0; i < numNeighbors; i++) {
        if (this.map.ownerID(this.nbuf[i]) === this.ownerSmallID) {
          onBorder = true;
          break;
        }
      }
      if (this.map.ownerID(tileToConquer) !== this.targetSmallID || !onBorder) {
        continue;
      }
      if (
        !this.map.isLand(tileToConquer) ||
        this.map.isImpassable(tileToConquer)
      ) {
        continue;
      }
      this.addNeighbors(tileToConquer);
      const { attackerTroopLoss, defenderTroopLoss, tilesPerTickUsed } = this.mg
        .config()
        .attackLogic(
          this.mg,
          troopCount,
          this._owner,
          this.target,
          tileToConquer,
        );
      numTilesPerTick -= tilesPerTickUsed;
      if (!this.passiveWilderness) troopCount -= attackerTroopLoss;
      this.attack.setTroops(troopCount);
      if (targetPlayer) {
        targetPlayer.removeTroops(defenderTroopLoss);
      }
      this._owner.conquer(tileToConquer);
      this.handleDeadDefender();
    }
  }

  private rejectIncomingAllianceRequests(target: Player) {
    const request = this._owner
      .incomingAllianceRequests()
      .find((ar) => ar.requestor() === target);
    if (request !== undefined) {
      request.reject();
    }
  }

  private addNeighbors(tile: TileRef) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const tickNow = this.mg.ticks(); // cache tick

    const numNeighbors = this.map.neighbors4(tile, this.nbuf);
    for (let i = 0; i < numNeighbors; i++) {
      const neighbor = this.nbuf[i];
      const terrain = this.map.terrainType(neighbor);
      if (
        terrain === TerrainType.Ocean ||
        terrain === TerrainType.Impassable ||
        this.map.ownerID(neighbor) !== this.targetSmallID
      ) {
        continue;
      }
      this.attack.addBorderTile(neighbor);
      let numOwnedByMe = 0;
      const numInner = this.map.neighbors4(neighbor, this.nbuf2);
      for (let j = 0; j < numInner; j++) {
        if (this.map.ownerID(this.nbuf2[j]) === this.ownerSmallID) {
          numOwnedByMe++;
        }
      }

      let mag: number;
      switch (terrain) {
        case TerrainType.Plains:
          mag = 1;
          break;
        case TerrainType.Highland:
          mag = 1.5;
          break;
        case TerrainType.Mountain:
          mag = 2;
          break;
        default:
          mag = 0;
          break;
      }

      const priority =
        (this.random.nextInt(0, 7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) +
        tickNow;

      this.toConquer.enqueue(neighbor, priority);
    }
  }

  private handleDeadDefender() {
    if (!(this.target.isPlayer() && this.target.numTilesOwned() < 100)) return;
    const target: Player = this.target;

    this.mg.conquerPlayer(this._owner, target);

    const MAX_PASSES = 100;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let progressed = false;
      for (const tile of target.tiles()) {
        let borders = false;
        this.mg.forEachNeighbor(tile, (t) => {
          if (!borders && this.mg.owner(t) === this._owner) {
            borders = true;
          }
        });
        if (borders) {
          this._owner.conquer(tile);
          progressed = true;
        } else {
          let captured = false;
          this.mg.forEachNeighbor(tile, (neighbor) => {
            if (captured) return;
            const no = this.mg.owner(neighbor);
            if (no.isPlayer() && no !== target && !no.isFriendly(target)) {
              this.mg.player(no.id()).conquer(tile);
              captured = true;
            }
          });
          if (captured) progressed = true;
        }
      }
      if (!progressed) break;
    }
  }

  owner(): Player {
    return this._owner;
  }

  isActive(): boolean {
    return this.active;
  }
}
