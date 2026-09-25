import { z } from "zod";
import { PlayerBuildable } from "../game/Game";
import type { GameUpdateViewData } from "../game/GameUpdates";
import type { WorkerMessage } from "../worker/WorkerMessages";

export const ViewQuerySchema = z.object({
  type: z.enum([
    "player_actions",
    "player_buildables",
    "player_profile",
    "player_border_tiles",
    "attack_clustered_positions",
    "transport_ship_spawn",
  ]),
  id: z.string().min(1).max(64),
  playerID: z.union([z.string().max(64), z.number().int().nonnegative()]),
  x: z.number().int().nonnegative().optional(),
  y: z.number().int().nonnegative().optional(),
  targetTile: z.number().int().nonnegative().optional(),
  attackID: z.string().max(64).optional(),
  units: z.array(z.enum(PlayerBuildable.types)).max(32).nullable().optional(),
});
export type ViewQuery = z.infer<typeof ViewQuerySchema>;
export const ClientViewMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("view_subscribe"),
    afterTick: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("view_ack"),
    sequence: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("view_query"), query: ViewQuerySchema }),
]);
export type ClientViewMessage = z.infer<typeof ClientViewMessageSchema>;
export type ViewPacket =
  | {
      kind: "update";
      update: GameUpdateViewData;
      snapshot?: "begin" | "part" | "end";
    }
  | { kind: "result"; message: WorkerMessage }
  | { kind: "error"; error: string; id?: string; reload?: boolean };

// Versioned binary envelope: JSON metadata followed by aligned typed-array
// payloads. Preserve undefined (diff clears), Set and bigint across the wire.
const MAGIC = 0x49465631;
export function encodeViewPacket(packet: ViewPacket): Uint8Array<ArrayBuffer> {
  const arrays: ArrayBufferView[] = [];
  let bytes = 0;
  const json = JSON.stringify(packet, (_key, value) => {
    if (value === undefined) return { $if: "undefined" };
    if (typeof value === "bigint")
      return { $if: "bigint", value: String(value) };
    if (value instanceof Set) return { $if: "set", value: [...value] };
    if (ArrayBuffer.isView(value)) {
      const entry = {
        $if: "array",
        type: value.constructor.name,
        offset: bytes,
        length: value.byteLength,
      };
      arrays.push(value);
      bytes += Math.ceil(value.byteLength / 8) * 8;
      return entry;
    }
    return value;
  });
  const meta = new TextEncoder().encode(json);
  const base = Math.ceil((12 + meta.length) / 8) * 8;
  const result = new Uint8Array(base + bytes);
  const header = new DataView(result.buffer);
  header.setUint32(0, MAGIC);
  header.setUint32(4, meta.length);
  header.setUint32(8, base);
  result.set(meta, 12);
  let offset = base;
  for (const a of arrays) {
    result.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offset);
    offset += Math.ceil(a.byteLength / 8) * 8;
  }
  return result;
}

export function decodeViewPacket(buffer: ArrayBuffer): ViewPacket {
  const header = new DataView(buffer);
  if (buffer.byteLength < 12 || header.getUint32(0) !== MAGIC)
    throw new Error("Unsupported view protocol");
  const length = header.getUint32(4);
  const base = header.getUint32(8);
  if (base < 12 + length || base > buffer.byteLength)
    throw new Error("Truncated view metadata");
  const hydrate = (value: any): any => {
    if (value === null || typeof value !== "object") return value;
    if (value.$if === "undefined") return undefined;
    if (value.$if === "bigint") return BigInt(value.value);
    if (value.$if === "set") return new Set(value.value.map(hydrate));
    if (value.$if === "array") {
      const constructors = {
        Uint8Array,
        Uint16Array,
        Uint32Array,
        Float64Array,
      };
      const Ctor = constructors[value.type as keyof typeof constructors];
      if (
        !Ctor ||
        value.offset < 0 ||
        value.length < 0 ||
        base + value.offset + value.length > buffer.byteLength
      )
        throw new Error("Invalid view buffer");
      // Own the small buffer; do not retain an entire snapshot via one subarray.
      return new Ctor(
        buffer.slice(base + value.offset, base + value.offset + value.length),
      );
    }
    for (const k of Object.keys(value)) value[k] = hydrate(value[k]);
    return value;
  };
  return hydrate(
    JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, length))),
  );
}
