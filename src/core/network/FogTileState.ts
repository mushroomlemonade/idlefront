/** Presentation-only bits. Never write these into the authoritative game map. */
export const FOG_CHARTED = 0x1000;
export const FOG_VISIBLE = 0x8000;

export function fogTileState(state: number, visible: boolean, explored: boolean): number {
  if (visible) return (state & 0x6fff) | FOG_VISIBLE | FOG_CHARTED;
  // Remember geography, never stale ownership, defense or fallout intelligence.
  return explored ? FOG_CHARTED : 0;
}
