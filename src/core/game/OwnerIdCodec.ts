/**
 * Version 2 extends owner IDs without repurposing any legacy tile flags.
 * State: owner low 12 bits at 0..11, existing flags at 12..15,
 * owner high four bits at 16..19. State fits exactly in a float32 attribute.
 * Wire: original low state and terrain byte remain at 0..23; the owner
 * extension occupies previously unused bits 24..27. Old words are unchanged.
 * Enabling this codec is a whole-world capability, not inferred from a tile.
 */
export const OWNER_ID_BITS_VERSION = 2 as const;
export const LEGACY_OWNER_MAX = 0xfff;
export const WIDE_OWNER_MAX = 0xffff;
export const EXTENDED_OWNER_MASK = 0xf0fff;
export const EXTENDED_STATE_MASK = 0xfffff;
export type TileStateArray = Uint16Array | Uint32Array;

/** Reserve the full nation/human roster, but do not double map memory merely
 * because a world is allowed to use extended IDs. The persisted roster is fixed. */
export function usesWideOwnerStorage(
  config: {
    bots: number;
    maxPlayers?: number;
    longplayStressTest?: string;
  },
  humans = 0,
): boolean {
  return (
    config.longplayStressTest === "owner16-v1" &&
    config.bots + Math.max(16, config.maxPlayers ?? 0, humans) + 401 > 4096
  );
}

export function ownerFromTileState(state: number): number {
  return (state & 0xfff) | ((state >>> 4) & 0xf000);
}

export function stateWithOwner(
  state: number,
  owner: number,
  wide: boolean,
): number {
  const maximum = wide ? WIDE_OWNER_MAX : LEGACY_OWNER_MAX;
  if (!Number.isInteger(owner) || owner < 0 || owner > maximum)
    throw new RangeError(`Invalid owner ID ${owner}; maximum ${maximum}`);
  return (state & 0xf000) | (owner & 0xfff) | ((owner & 0xf000) << 4);
}

export function packTileState(state: number, terrain: number): number {
  return (state & 0xffff) | ((terrain & 0xff) << 16) | ((state & 0xf0000) << 8);
}

export function unpackTileState(packed: number): number {
  return (packed & 0xffff) | ((packed >>> 8) & 0xf0000);
}

export function unpackTileTerrain(packed: number): number {
  return (packed >>> 16) & 0xff;
}

/** Reject unsupported data instead of silently truncating extended owners. */
export function checkedTileState(packed: number, wide: boolean): number {
  if (!Number.isInteger(packed) || packed < 0 || packed > 0x0fffffff)
    throw new RangeError("Invalid packed tile word");
  const state = unpackTileState(packed);
  if (!wide && (state & 0xf0000) !== 0)
    throw new RangeError("Extended owner received by a legacy world");
  return state;
}

/** Preserve visible owners and flags; hidden tiles reveal no owner extension. */
export function projectedTileState(
  state: number,
  visible: boolean,
  explored: boolean,
): number {
  if (visible) return (state & 0xf6fff) | 0x9000;
  return explored ? 0x1000 : 0;
}

/** Flat logical owner tables become 256-wide GPU textures, never 65536 wide. */
export function ownerTextureCoordinate(
  owner: number,
  logicalRow = 0,
): [number, number] {
  if (
    !Number.isInteger(owner) ||
    owner < 0 ||
    owner > WIDE_OWNER_MAX ||
    !Number.isInteger(logicalRow) ||
    logicalRow < 0
  )
    throw new RangeError("Invalid owner texture coordinate");
  return [owner & 255, (owner >>> 8) + logicalRow * 256];
}
