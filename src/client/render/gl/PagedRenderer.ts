import type { Config } from "../../../core/configuration/Config";
import type { GameMap } from "../../../core/game/GameMap";
import type { MapLayer } from "../../../core/game/TerrainMapLoader";
import type { SpiralRibbon } from "../frame/SpiralTrails";
import type {
  AttackRingInput,
  BonusEvent,
  ConquestFx,
  DeadUnitFx,
  GhostPreviewData,
  NameEntry,
  NukeTelegraphData,
  NukeTrajectoryData,
  PlayerState,
  PlayerStatic,
  PlayerStatusData,
  RendererConfig,
  UnitState,
} from "../types";
import { Camera } from "./Camera";
import { GLUnavailableError, initGL } from "./initGL";
import { BarPass } from "./passes/BarPass";
import { CrosshairPass } from "./passes/CrosshairPass";
import { FxPass } from "./passes/fx-pass";
import { MoveIndicatorPass } from "./passes/MoveIndicatorPass";
import { NamePass } from "./passes/name-pass";
import { NukeTelegraphPass } from "./passes/NukeTelegraphPass";
import { NukeTrajectoryPass } from "./passes/NukeTrajectoryPass";
import { OverviewMapPass } from "./passes/OverviewMapPass";
import { RangeCirclePass } from "./passes/RangeCirclePass";
import { SelectionBoxPass, type SelectionEntry } from "./passes/SelectionBoxPass";
import { SparseRailroadPass } from "./passes/SparseRailroadPass";
import { SparseTrailPass } from "./passes/SparseTrailPass";
import type { SpawnCenter } from "./passes/SpawnOverlayPass";
import { StructureLevelPass } from "./passes/StructureLevelPass";
import { StructurePass } from "./passes/StructurePass";
import { UnitPass } from "./passes/UnitPass";
import {
  type AttackTroopLabel,
  WorldTextPass,
} from "./passes/WorldTextPass";
import type { RenderSettings } from "./RenderSettings";
import {
  EFFECT_PALETTE_BLOCKS,
  getPaletteSize,
  MAX_TRAIL_COLORS,
} from "./utils/ColorUtils";
import { renderDpr } from "./utils/Dpr";
import { createTexture2D } from "./utils/GlUtils";

/**
 * Renderer for page-backed worlds. It keeps full-resolution rules and world
 * coordinates while bounding every map raster on the GPU. The whole-world LOD
 * is fixed-size and native-resolution detail is supplied by an LRU page atlas.
 */
export class PagedRenderer {
  private fogEnabled = false;
  private readonly fogReducedMotion = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  setFog(enabled: boolean): void { this.fogEnabled = enabled; }
  private readonly gl: WebGL2RenderingContext;
  private readonly camera: Camera;
  private readonly overviewPass: OverviewMapPass;
  private readonly paletteTex: WebGLTexture;
  private readonly effectTex: WebGLTexture;
  private readonly paletteData: Float32Array;
  private readonly structurePass: StructurePass;
  private readonly structureLevelPass: StructureLevelPass;
  private readonly unitPass: UnitPass;
  private readonly namePass: NamePass;
  private readonly barPass: BarPass;
  private readonly fxPass: FxPass;
  private readonly worldTextPass: WorldTextPass;
  private readonly rangeCirclePass: RangeCirclePass;
  private readonly crosshairPass: CrosshairPass;
  private readonly selectionBoxPass: SelectionBoxPass;
  private readonly railroadPass: SparseRailroadPass;
  private readonly trailPass: SparseTrailPass;
  private readonly moveIndicatorPass: MoveIndicatorPass;
  private readonly nukeTrajectoryPass: NukeTrajectoryPass;
  private readonly nukeTelegraphPass: NukeTelegraphPass;
  private readonly mapW: number;
  private readonly resolutionScale: number;
  private lastUnits = new Map<number, UnitState>();
  private lastStructures = new Map<number, UnitState>();
  private selectedUnitIds: number[] = [];
  private selectionEntries: SelectionEntry[] = [];
  private frameTick = 0;
  private localPlayerID = 0;
  private altView = false;
  private canvasW = 1;
  private canvasH = 1;
  private cameraX = 0;
  private cameraY = 0;
  private cameraZoom = 1;
  private animId: number | null = null;
  private readonly raf: typeof requestAnimationFrame;
  private readonly caf: typeof cancelAnimationFrame;

  readonly glLimited: { renderer: string; maxTextureSize: number } | null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    header: RendererConfig,
    map: GameMap,
    paletteData: Float32Array,
    private readonly config: Config,
    private readonly settings: RenderSettings,
    raf: typeof requestAnimationFrame = requestAnimationFrame,
    caf: typeof cancelAnimationFrame = cancelAnimationFrame,
  ) {
    const result = initGL(canvas, {
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
    });
    if (result.gl === null) {
      throw new GLUnavailableError(result.status, result.renderer);
    }
    this.glLimited =
      result.status === "limited"
        ? {
            renderer: result.renderer,
            maxTextureSize: result.maxTextureSize,
          }
        : null;
    this.gl = result.gl;
    this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT, 1);
    this.raf = raf;
    this.caf = caf;
    this.mapW = header.mapWidth;
    // Expanded Earth maps retain the 4108-wide upstream world's geography
    // while increasing logical resolution. Normalize zoom-sensitive overlays
    // so they appear at the same geographic scale.
    // Map enlargement adds tiles, not larger pixels. Scaling detail by total
    // map width inflated structures, rails and wakes ~5.2x on Pixel Earth 27x.
    // Match the ordinary renderer's camera zoom and native tile proportions.
    this.resolutionScale = 1;
    this.camera = new Camera(header.mapWidth, header.mapHeight);
    this.cameraX = header.mapWidth / 2;
    this.cameraY = header.mapHeight / 2;
    this.paletteData = new Float32Array(paletteData);
    this.paletteTex = createTexture2D(this.gl, {
      width: getPaletteSize(),
      height: 2,
      internalFormat: this.gl.RGBA32F,
      format: this.gl.RGBA,
      type: this.gl.FLOAT,
      data: this.paletteData,
      filter: this.gl.NEAREST,
    });
    this.effectTex = createTexture2D(this.gl, {
      width: getPaletteSize(),
      height: MAX_TRAIL_COLORS * EFFECT_PALETTE_BLOCKS,
      internalFormat: this.gl.RGBA32F,
      format: this.gl.RGBA,
      type: this.gl.FLOAT,
      data: new Float32Array(
        getPaletteSize() * MAX_TRAIL_COLORS * EFFECT_PALETTE_BLOCKS * 4,
      ),
      filter: this.gl.NEAREST,
    });

    this.overviewPass = new OverviewMapPass(
      this.gl,
      map,
      this.paletteTex,
      settings,
    );
    this.structurePass = new StructurePass(
      this.gl,
      header,
      this.paletteTex,
      this.effectTex,
      settings,
    );
    this.structureLevelPass = new StructureLevelPass(
      this.gl,
      header,
      settings,
    );
    this.unitPass = new UnitPass(
      this.gl,
      header,
      this.paletteTex,
      this.effectTex,
      settings,
      config,
    );
    this.namePass = new NamePass(
      this.gl,
      header,
      this.paletteData,
      settings,
      config,
    );
    this.barPass = new BarPass(this.gl, header, settings, config);
    this.fxPass = new FxPass(this.gl, header, settings, config);
    this.worldTextPass = new WorldTextPass(this.gl, settings, config);
    this.worldTextPass.setMapWidth(this.mapW);
    this.rangeCirclePass = new RangeCirclePass(this.gl);
    this.crosshairPass = new CrosshairPass(this.gl);
    this.selectionBoxPass = new SelectionBoxPass(this.gl);
    this.railroadPass = new SparseRailroadPass(
      this.gl,
      map,
      this.paletteTex,
      settings,
    );
    this.trailPass = new SparseTrailPass(
      this.gl,
      header.mapWidth,
      this.paletteTex,
      this.effectTex,
      settings,
    );
    this.moveIndicatorPass = new MoveIndicatorPass(this.gl, settings);
    this.nukeTrajectoryPass = new NukeTrajectoryPass(this.gl, settings);
    this.nukeTelegraphPass = new NukeTelegraphPass(this.gl, settings);
    this.startLoop();
  }

  resize(cssWidth: number, cssHeight: number): void {
    const dpr = renderDpr();
    this.canvasW = Math.max(1, Math.round(cssWidth * dpr));
    this.canvasH = Math.max(1, Math.round(cssHeight * dpr));
    this.canvas.width = this.canvasW;
    this.canvas.height = this.canvasH;
    this.camera.resize(cssWidth, cssHeight);
  }

  setCameraState(x: number, y: number, z: number): void {
    this.cameraX = x;
    this.cameraY = y;
    this.cameraZoom = z;
    this.camera.setCameraState(x, y, z);
  }

  uploadTileAndTrailState(
    _tiles: Uint16Array,
    _trails: Uint16Array,
    sparseTrails?: ReadonlyMap<number, number> | null,
  ): void {
    this.overviewPass.rebuild();
    if (sparseTrails) this.trailPass.replace(sparseTrails);
  }

  uploadLiveDelta(
    _tileState: Uint16Array,
    changedTiles: readonly number[],
  ): void {
    this.overviewPass.applyChangedTiles(changedTiles);
  }

  uploadLiveTrailDelta(
    _trailState: Uint16Array,
    dirtyTiles: readonly number[],
    sparseTrails?: ReadonlyMap<number, number> | null,
  ): void {
    if (sparseTrails) this.trailPass.apply(sparseTrails, dirtyTiles);
  }

  updateSpiralRibbons(_ribbons: readonly SpiralRibbon[]): void {}

  updatePalette(paletteData: Float32Array): void {
    this.paletteData.set(paletteData);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.paletteTex);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      0,
      0,
      getPaletteSize(),
      2,
      this.gl.RGBA,
      this.gl.FLOAT,
      this.paletteData,
    );
    this.namePass.refreshPlayerColors(this.paletteData);
  }

  updateEffectPalette(data: Float32Array): void {
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.effectTex);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      0,
      0,
      getPaletteSize(),
      MAX_TRAIL_COLORS * EFFECT_PALETTE_BLOCKS,
      this.gl.RGBA,
      this.gl.FLOAT,
      data,
    );
  }

  addPlayers(
    players: PlayerStatic[],
    paletteData: Float32Array,
    _patternMeta: Float32Array,
    _patternData: Uint8Array,
  ): void {
    this.updatePalette(paletteData);
    this.namePass.addPlayers(players, this.paletteData);
  }

  setPlayerSkin(_smallID: number, _url: string): void {}
  initSkinAtlas(_urls: readonly string[]): void {}
  setPlayerSpawn(_smallID: number, _x: number, _y: number): void {}
  uploadRailroadState(
    _data: Uint8Array,
    _dirty: readonly number[],
    sparseState?: ReadonlyMap<number, number> | null,
  ): void {
    if (sparseState) this.railroadPass.replace(sparseState);
  }

  updateUnits(units: Map<number, UnitState>, gameTick: number): void {
    this.lastUnits = units;
    this.frameTick++;
    this.unitPass.setFrameTick(this.frameTick);
    this.unitPass.updateUnits(units, gameTick);
    this.barPass.updateBars(units, this.lastStructures, gameTick);
  }

  updateNames(
    names: Map<string, NameEntry>,
    players: Map<number, PlayerState>,
    snap: boolean,
    statusData?: Map<number, PlayerStatusData>,
  ): void {
    this.namePass.updateNames(names, players, snap, statusData);
  }

  refreshNames(names: Map<string, string>): void {
    this.namePass.refreshNames(names);
  }

  updateRelations(_data: Uint8Array, _size: number): void {}

  updateStructures(units: Map<number, UnitState>): void {
    this.lastStructures = units;
    this.structurePass.updateStructures(units);
    this.structureLevelPass.updateStructures(units);
    this.unitPass.setStructures(units);
  }

  applyDeadUnits(events: DeadUnitFx[]): void {
    this.fxPass.applyDeadUnits(events);
  }
  applyConquestEvents(events: ConquestFx[]): void {
    this.fxPass.applyConquestEvents(events);
    this.worldTextPass.applyConquestEvents(events);
  }
  setAttackTroopLabels(labels: AttackTroopLabel[]): void {
    this.worldTextPass.setAttackTroopLabels(labels);
  }
  applyBonusEvents(events: BonusEvent[]): void {
    this.worldTextPass.applyBonusEvents(events);
  }
  applyRailroadDust(refs: number[]): void {
    this.fxPass.applyRailroadDust(refs);
  }
  applyTerrainDelta(refs: readonly number[], _terrain: Uint8Array): void {
    this.overviewPass.applyTerrainDelta(refs);
  }
  rebuildTerrain(): void {}
  updateAttackRings(rings: AttackRingInput[]): void {
    this.fxPass.updateAttackRings(rings);
  }
  updateGhostPreview(data: GhostPreviewData | null): void {
    this.structurePass.updateGhostPreview(data);
    this.rangeCirclePass.updateGhostPreview(data);
    this.crosshairPass.updateGhostPreview(data);
  }
  updateNukeTrajectory(data: NukeTrajectoryData | null): void {
    this.nukeTrajectoryPass.update(data);
  }
  updateNukeTelegraphs(data: NukeTelegraphData[]): void {
    this.nukeTelegraphPass.update(data);
  }
  updateSpawnOverlay(_active: boolean, _centers: SpawnCenter[]): void {}
  updateSmallPlayerGlow(_set: Uint8Array | null): void {}
  setMapLayers(_layers: MapLayer[], _images: Map<string, ImageBitmap>): void {}
  setLayerVisible(_id: string, _visible: boolean): void {}
  markLayerTilesDestroyed(_id: string, _tiles: number[]): void {}
  setLayerDestroyedMask(_id: string, _mask: Uint8Array): void {}

  setSelectedUnits(unitIds: readonly number[]): void {
    this.selectedUnitIds = [...unitIds];
  }

  showMoveIndicator(x: number, y: number, ownerID: number): void {
    const offset = ownerID * 4;
    this.moveIndicatorPass.show(
      x,
      y,
      this.paletteData[offset] ?? 1,
      this.paletteData[offset + 1] ?? 1,
      this.paletteData[offset + 2] ?? 1,
    );
  }

  setSAMAllianceClusters(_clusters: Map<number, number>): void {}
  setLocalPlayerID(id: number): void {
    this.localPlayerID = id;
    this.railroadPass.setLocalPlayer(id);
    this.structurePass.setLocalPlayer(id);
    this.unitPass.setLocalPlayer(id);
  }
  setLocalRailColor(r: number, g: number, b: number): void {
    this.railroadPass.setLocalColor(r, g, b);
  }
  setAltView(active: boolean): void {
    this.altView = active;
    this.structurePass.setAltView(active);
    this.unitPass.setAltView(active);
    this.trailPass.setAltView(active);
  }
  setGridView(_active: boolean): void {}
  setShowPatterns(_active: boolean): void {}
  setHighlightOwner(owner: number): void {
    this.overviewPass.setHighlightOwner(owner);
    this.namePass.setHighlightOwner(owner);
    this.structurePass.setHighlightOwner(owner);
  }
  setMouseWorldPos(x: number, y: number): void {
    this.namePass.setMouseWorldPos(x, y);
  }
  setHighlightStructureTypes(types: string[] | null): void {
    this.structurePass.setHighlightTypes(types);
    this.structureLevelPass.setHighlightTypes(types);
  }
  getSettings(): RenderSettings {
    return this.settings;
  }

  private startLoop(): void {
    this.animId ??= this.raf(this.renderLoop);
  }

  private renderLoop = (): void => {
    this.draw();
    this.animId = this.raf(this.renderLoop);
  };

  private draw(): void {
    this.overviewPass.updateCamera(
      this.cameraX,
      this.cameraY,
      this.cameraZoom,
      this.canvasW,
      this.canvasH,
    );
    const gl = this.gl;
    const cam = this.camera.getMatrix();
    const zoom = this.camera.zoom;
    const lodZoom = zoom * this.resolutionScale;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.clearColor(60 / 255, 60 / 255, 60 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.overviewPass.setFogRendering(this.fogEnabled, this.fogReducedMotion ? 0 : performance.now() / 1000);
    this.overviewPass.draw(cam);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.railroadPass.draw(cam, zoom, this.resolutionScale);
    this.unitPass.drawGround(cam);
    this.rangeCirclePass.draw(cam);
    this.nukeTrajectoryPass.draw(cam);
    this.crosshairPass.draw(cam);
    this.structurePass.draw(cam, zoom, lodZoom);
    this.structureLevelPass.draw(cam, zoom, lodZoom);
    this.barPass.draw(cam);
    this.updateSelectionBox();
    this.selectionBoxPass.draw(cam, this.frameTick);
    this.moveIndicatorPass.draw(cam, zoom);
    this.nukeTelegraphPass.draw(cam);
    this.trailPass.draw(cam, zoom, this.resolutionScale);
    this.unitPass.drawMissiles(cam);
    this.fxPass.tick();
    this.fxPass.draw(cam, zoom);
    if (!this.altView) this.namePass.draw(cam, 1);
    this.worldTextPass.tick(zoom);
    this.worldTextPass.draw(cam, zoom, lodZoom);
    gl.disable(gl.BLEND);
  }

  private updateSelectionBox(): void {
    this.selectionEntries.length = 0;
    const live: number[] = [];
    for (const id of this.selectedUnitIds) {
      const unit = this.lastUnits.get(id);
      if (!unit || !unit.isActive) continue;
      live.push(id);
      const x = unit.pos % this.mapW;
      const y = (unit.pos - x) / this.mapW;
      const offset = unit.ownerID * 4;
      this.selectionEntries.push({
        centerX: x,
        centerY: y,
        r: this.paletteData[offset] ?? 1,
        g: this.paletteData[offset + 1] ?? 1,
        b: this.paletteData[offset + 2] ?? 1,
      });
    }
    this.selectedUnitIds = live;
    this.selectionBoxPass.setSelections(this.selectionEntries);
  }

  dispose(): void {
    if (this.animId !== null) this.caf(this.animId);
    this.animId = null;
    this.overviewPass.dispose();
    this.structurePass.dispose();
    this.structureLevelPass.dispose();
    this.unitPass.dispose();
    this.namePass.dispose();
    this.barPass.dispose();
    this.fxPass.dispose();
    this.worldTextPass.dispose();
    this.rangeCirclePass.dispose();
    this.crosshairPass.dispose();
    this.selectionBoxPass.dispose();
    this.railroadPass.dispose();
    this.trailPass.dispose();
    this.moveIndicatorPass.dispose();
    this.nukeTrajectoryPass.dispose();
    this.nukeTelegraphPass.dispose();
    this.gl.deleteTexture(this.paletteTex);
    this.gl.deleteTexture(this.effectTex);
  }
}
