import { GameUpdateType, type PlayerUpdate } from "../game/GameUpdates";
import type { ViewPacket } from "./ViewProtocol";

const numeric = [
  "civilians",
  "military",
  "target",
  "effectiveTarget",
  "growthPerSecond",
] as const;
const boolean = ["automatic", "autoDefenceEnabled", "explicitIdle"] as const;
const fields = [...numeric, ...boolean];
const known = new Set(fields);
const owns = (object: object, key: string) =>
  Object.prototype.hasOwnProperty.call(object, key);

function eligible(player: PlayerUpdate): boolean {
  const p = player.pressure;
  return (
    !!p &&
    Object.keys(p).every((k) => known.has(k as (typeof fields)[number])) &&
    numeric.every((k) => p[k] === undefined || Number.isFinite(p[k])) &&
    boolean.every((k) => p[k] === undefined || typeof p[k] === "boolean")
  );
}

/** Lossless transport only: no quantization, omitted fields, or simulation changes.
 * Each pressure record is 48 bytes instead of a repeated JSON object. Unknown
 * future fields fall back to ordinary encoding rather than being discarded. */
export function packPressureTable(packet: ViewPacket): unknown {
  if (packet.kind !== "update") return packet;
  const players = packet.update.updates[GameUpdateType.Player];
  const count = players.filter(eligible).length;
  if (!count) return packet;
  const indices = new Uint32Array(count * 2);
  const values = new Float64Array(count * numeric.length);
  let row = 0;
  const updates = players.map((player, index) => {
    if (!eligible(player)) return player;
    const p = player.pressure!;
    let mask = 0;
    fields.forEach((key, field) => {
      // 0 = absent, 1 = explicit undefined, 2 = value/false, 3 = true.
      const state = !owns(p, key)
        ? 0
        : p[key] === undefined
          ? 1
          : p[key] === true
            ? 3
            : 2;
      mask |= state << (field * 2);
      if (field < numeric.length && state === 2)
        values[field * count + row] = p[key] as number;
    });
    indices[row * 2] = index;
    indices[row * 2 + 1] = mask;
    row++;
    const copy = { ...player };
    delete copy.pressure;
    return copy;
  });
  return {
    $if: "pressure-table-v1",
    indices,
    values,
    packet: {
      ...packet,
      update: {
        ...packet.update,
        updates: { ...packet.update.updates, [GameUpdateType.Player]: updates },
      },
    },
  };
}

export function unpackPressureTable(value: any): ViewPacket {
  if (value?.$if !== "pressure-table-v1") return value;
  const { packet, indices, values } = value;
  const players = packet?.update?.updates?.[GameUpdateType.Player];
  if (
    packet?.kind !== "update" ||
    !Array.isArray(players) ||
    !(indices instanceof Uint32Array) ||
    !(values instanceof Float64Array) ||
    indices.length % 2 ||
    values.length !== (indices.length / 2) * numeric.length ||
    indices.length / 2 > players.length
  )
    throw new Error("Invalid pressure table");
  let previous = -1;
  for (let row = 0; row < indices.length / 2; row++) {
    const index = indices[row * 2],
      mask = indices[row * 2 + 1];
    if (
      index <= previous ||
      index >= players.length ||
      mask > 65535 ||
      owns(players[index], "pressure")
    )
      throw new Error("Invalid pressure table index");
    previous = index;
    const pressure: Record<string, number | boolean | undefined> = {};
    fields.forEach((key, field) => {
      const state = (mask >>> (field * 2)) & 3;
      if (!state) return;
      if (field < numeric.length && state === 3)
        throw new Error("Invalid pressure value");
      const number = values[field * (indices.length / 2) + row];
      if (field < numeric.length && state === 2 && !Number.isFinite(number))
        throw new Error("Invalid pressure number");
      pressure[key] =
        state === 1 ? undefined : field < numeric.length ? number : state === 3;
    });
    players[index].pressure = pressure;
  }
  return packet;
}
