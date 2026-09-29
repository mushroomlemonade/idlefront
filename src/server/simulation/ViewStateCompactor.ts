import { UnitType } from "../../core/game/Game";
import {
  GameUpdateType,
  type GameUpdateViewData,
  type PlayerUpdate,
  type UnitUpdate,
} from "../../core/game/GameUpdates";
import {
  decodeViewPacket,
  encodeViewPacket,
} from "../../core/network/ViewProtocol";

/** Share one budget across a game's viewers, not one budget per socket.
 * A single synchronous merge may overrun the budget; subsequent work yields.
 * Normal delivery does no compaction work at all. Input bytes are bounded below.
 */
export class BoundedViewStateCompactor {
  private windowAt = -Infinity;
  private spentMs = 0;
  readonly metrics = { attempts: 0, budgetSkips: 0, totalMs: 0 };
  constructor(
    private readonly now = () => performance.now(),
    private readonly merge = compactViewState,
  ) {}
  compact = (older: Uint8Array, newer: Uint8Array): Uint8Array | undefined => {
    const started = this.now();
    if (started - this.windowAt >= 100) {
      this.windowAt = started;
      this.spentMs = 0;
    }
    if (this.spentMs >= 15) {
      this.metrics.budgetSkips++;
      return undefined;
    }
    this.metrics.attempts++;
    const result = this.merge(older, newer);
    const elapsed = this.now() - started;
    this.spentMs += elapsed;
    this.metrics.totalMs += elapsed;
    return result;
  };
}

// Only replaceable presentation state is eligible. Every event, fog change,
// motion/rail plan, terrain mutation and unit lifecycle change is a barrier.
// Attack quads address arrays by index: membership changes must be barriers too.
const playerFields = new Set([
  "type",
  "id",
  "gold",
  "troops",
  "tilesOwned",
  "pressure",
  "fleet",
  "nameViewData",
  "traitorRemainingTicks",
]);
const mobileTypes = new Set([
  UnitType.Warship,
  UnitType.TradeShip,
  UnitType.TransportShip,
]);
function eligible(u: GameUpdateViewData): boolean {
  if (
    u.fog ||
    u.snapshotPhase ||
    u.packedTradeCorridors !== undefined ||
    u.packedTileRuns?.length ||
    u.packedTerrainUpdates?.length ||
    u.packedMotionPlans?.length ||
    u.packedNukeImpacts?.length
  )
    return false;
  for (const [type, updates] of Object.entries(u.updates))
    if (
      updates.length &&
      Number(type) !== GameUpdateType.Unit &&
      Number(type) !== GameUpdateType.Player
    )
      return false;
  if (
    u.updates[GameUpdateType.Player].some((p) =>
      Object.keys(p).some((key) => !playerFields.has(key)),
    )
  )
    return false;
  return u.updates[GameUpdateType.Unit].every(
    (unit) =>
      mobileTypes.has(unit.unitType) &&
      unit.isActive &&
      !unit.reachedTarget &&
      unit.markedForDeletion === false &&
      !unit.underConstruction &&
      (unit.lastOwnerID === undefined || unit.lastOwnerID === unit.ownerID),
  );
}

function records<T extends Uint32Array | Float64Array>(
  older: T | undefined,
  newer: T | undefined,
  stride: number,
  keys: number,
  make: (values: number[]) => T,
): T | undefined {
  if (!older?.length) return newer;
  if (!newer?.length) return older;
  const values = new Map<string, number[]>();
  for (const buffer of [older, newer]) {
    for (let i = 0; i < buffer.length; i += stride) {
      const record = Array.from(buffer.subarray(i, i + stride));
      values.set(record.slice(0, keys).join(":"), record);
    }
  }
  return make([...values.values()].flat());
}

/** No inputs are mutated; encoded buffers can be shared by different viewers. */
export function compactViewState(
  older: Uint8Array,
  newer: Uint8Array,
): Uint8Array | undefined {
  // Bound work and retain the existing queue overflow protection for huge frames.
  if (older.byteLength + newer.byteLength > 4 * 1024 * 1024) return undefined;
  try {
    const a = decodeViewPacket(Uint8Array.from(older).buffer);
    const b = decodeViewPacket(Uint8Array.from(newer).buffer);
    if (
      a.kind !== "update" ||
      b.kind !== "update" ||
      a.snapshot ||
      b.snapshot ||
      b.update.tick <= a.update.tick ||
      !eligible(a.update) ||
      !eligible(b.update)
    )
      return undefined;
    const previous = a.update,
      next = b.update;
    // Byte limits alone are insufficient: tiny numeric records can otherwise
    // create hundreds of thousands of Map entries in one synchronous merge.
    if (
      previous.updates[GameUpdateType.Unit].length +
        next.updates[GameUpdateType.Unit].length >
        8192 ||
      previous.packedTileUpdates.length + next.packedTileUpdates.length >
        16384 ||
      (previous.packedPlayerUpdates?.length ?? 0) +
        (next.packedPlayerUpdates?.length ?? 0) >
        16384 ||
      (previous.packedAttackUpdates?.length ?? 0) +
        (next.packedAttackUpdates?.length ?? 0) >
        32768
    )
      return undefined;
    const units = new Map<number, UnitUpdate>();
    for (const unit of previous.updates[GameUpdateType.Unit])
      units.set(unit.id, unit);
    for (const unit of next.updates[GameUpdateType.Unit]) {
      const old = units.get(unit.id);
      if (
        old &&
        (old.ownerID !== unit.ownerID || old.unitType !== unit.unitType)
      )
        return undefined;
      units.set(unit.id, unit);
    }
    const players = new Map<string, PlayerUpdate>();
    for (const player of [
      ...previous.updates[GameUpdateType.Player],
      ...next.updates[GameUpdateType.Player],
    ])
      players.set(player.id, { ...players.get(player.id), ...player });
    const update: GameUpdateViewData = {
      ...next,
      updates: {
        ...next.updates,
        [GameUpdateType.Unit]: [...units.values()],
        [GameUpdateType.Player]: [...players.values()],
      },
      packedTileUpdates: records(
        previous.packedTileUpdates,
        next.packedTileUpdates,
        2,
        1,
        (v) => new Uint32Array(v),
      )!,
      packedPlayerUpdates: records(
        previous.packedPlayerUpdates,
        next.packedPlayerUpdates,
        4,
        1,
        (v) => new Float64Array(v),
      ),
      packedAttackUpdates: records(
        previous.packedAttackUpdates,
        next.packedAttackUpdates,
        4,
        3,
        (v) => new Float64Array(v),
      ),
      playerNameViewData: {
        ...previous.playerNameViewData,
        ...next.playerNameViewData,
      },
    };
    const encoded = encodeViewPacket({ kind: "update", update });
    return encoded.byteLength < older.byteLength + newer.byteLength
      ? encoded
      : undefined;
  } catch {
    // Unknown protocol/shape is delivered unchanged, never discarded.
    return undefined;
  }
}
