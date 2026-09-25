import type { SpiralRibbon } from "../frame/SpiralTrails";
import type { FrameEvents } from "./FrameEvents";
import type {
  AttackRingInput,
  NameEntry,
  NukeTelegraphData,
  PlayerState,
  PlayerStatusData,
  UnitState,
} from "./Renderer";

/**
 * FrameData — the boundary contract between game integration and the
 * renderer. Built once per tick by GameView; the renderer reads from this
 * interface and never touches game internals directly.
 *
 * Arrays are long-lived and mutated in place each tick (zero-copy refs).
 */
export interface FrameData {
  readonly fogEnabled?: boolean;
  // ── Core accumulated state ────────────────────────────────────────────

  readonly tick: number;
  /** True during spawn phase (before gameplay begins). */
  readonly inSpawnPhase: boolean;
  readonly tileState: Uint16Array;
  readonly trailState: Uint16Array;
  /** Live sparse trail state used by page-backed worlds. */
  readonly trailSparseState: ReadonlyMap<number, number> | null;
  readonly railroadState: Uint8Array;
  /** Live sparse rail state used by page-backed worlds. */
  readonly railroadSparseState: ReadonlyMap<number, number> | null;
  readonly units: ReadonlyMap<number, UnitState>;
  /** Active renderer candidates excluding stationary structures. */
  readonly mobileUnits: ReadonlyMap<number, UnitState>;
  /** Structure-only state, rebuilt only on structure lifecycle changes. */
  readonly structures: ReadonlyMap<number, UnitState>;
  readonly players: ReadonlyMap<number, PlayerState>;
  readonly names: ReadonlyMap<string, NameEntry>;

  // ── Per-frame events ──────────────────────────────────────────────────

  /** Everything that happened this frame — rendering FX and stats events. */
  readonly events: FrameEvents;

  // ── Upload hints ──────────────────────────────────────────────────────

  /**
   * Changed tile refs this frame for delta uploads.
   * - `null` → no delta info; full upload needed (first tick)
   * - array → only these tiles changed (empty = skip upload)
   */
  readonly changedTiles: readonly number[] | null;
  readonly railroadDirty: boolean;
  /** Exact changed railroad texels for sparse GPU uploads. */
  readonly railroadDirtyTiles: readonly number[];
  readonly revealedRailTiles: number[];

  /** Exact changed trail texels for sparse GPU uploads. */
  readonly trailDirtyTiles: readonly number[];

  /**
   * Live spiral nukeTrail ribbons (helix polylines from SpiralTrails) —
   * empty while no spiral-cosmetic nuke is in flight. Live ref, mutated in
   * place each tick like the state buffers above.
   */
  readonly spiralRibbons: readonly SpiralRibbon[];

  // ── Derived (computed once by producer) ────────────────────────────────

  readonly playerStatus: ReadonlyMap<number, PlayerStatusData>;
  readonly relationMatrix: Uint8Array;
  readonly relationSize: number;
  /**
   * True when relationMatrix was rebuilt this tick (alliance/embargo change).
   * Consumers skip the GPU upload — and the full-map border recompute it
   * triggers — when false.
   */
  readonly relationsDirty: boolean;
  readonly allianceClusters: ReadonlyMap<number, number>;
  readonly nukeTelegraphs: NukeTelegraphData[];
  readonly attackRings: AttackRingInput[];
  /** True when structures changed this tick (added/removed/level change). */
  readonly structuresDirty: boolean;
}
