import { Cell, TerrainType } from "./Game";
import type { GameMap, GameMapTilePage, TileRef } from "./GameMap";

export interface TerrainPageInput {
  readonly pageX: number;
  readonly pageY: number;
  readonly width: number;
  readonly height: number;
  readonly terrain: Uint8Array;
}

interface InternalTilePage {
  readonly index: number;
  readonly pageX: number;
  readonly pageY: number;
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  readonly terrain: Uint8Array;
  state: Uint16Array | null;
  publicPage: GameMapTilePage;
}

/**
 * Page-backed implementation of the stock GameMap contract.
 *
 * TileRef remains the canonical row-major world reference, which keeps every
 * existing rule and intent compatible. Only storage is paged: no world-sized
 * terrain/state allocation is created here.
 */
export class PagedGameMap implements GameMap {
  private static readonly IS_LAND_BIT = 7;
  private static readonly SHORELINE_BIT = 6;
  private static readonly OCEAN_BIT = 5;
  private static readonly MAGNITUDE_MASK = 0x1f;
  private static readonly IMPASSABLE_MAGNITUDE = 31;
  private static readonly PLAYER_ID_MASK = 0xfff;
  private static readonly FALLOUT_BIT = 13;
  private static readonly DEFENSE_BONUS_BIT = 14;

  private readonly pages: InternalTilePage[];
  private readonly publicPages: GameMapTilePage[];
  private readonly pagesWide: number;
  private readonly pagesHigh: number;
  /** Tiny coordinate tables avoid page-grid division in every hot tile read. */
  private readonly pageColumnByX: Uint32Array;
  private readonly localXByX: Uint32Array;
  private readonly pageRowBaseByY: Uint32Array;
  private readonly localYByY: Uint32Array;
  private falloutTiles = 0;
  private stateObservers = new Set<(tile: TileRef) => void>();
  private stateObserver?: (tile: TileRef) => void;

  observeState(listener: (tile: TileRef) => void): () => void {
    this.stateObservers.add(listener);
    const refresh = () => {
      this.stateObserver = this.stateObservers.size === 0 ? undefined :
        this.stateObservers.size === 1 ? this.stateObservers.values().next().value :
        (tile) => { for (const callback of this.stateObservers) callback(tile); };
    };
    refresh();
    return () => { this.stateObservers.delete(listener); refresh(); };
  }

  constructor(
    private readonly width_: number,
    private readonly height_: number,
    private readonly pageSize_: number,
    terrainPages: readonly TerrainPageInput[],
    private landTiles_: number,
  ) {
    if (!Number.isSafeInteger(width_) || width_ <= 0) {
      throw new Error(`Invalid paged map width ${width_}`);
    }
    if (!Number.isSafeInteger(height_) || height_ <= 0) {
      throw new Error(`Invalid paged map height ${height_}`);
    }
    if (!Number.isSafeInteger(pageSize_) || pageSize_ <= 0) {
      throw new Error(`Invalid page size ${pageSize_}`);
    }

    this.pagesWide = Math.ceil(width_ / pageSize_);
    this.pagesHigh = Math.ceil(height_ / pageSize_);
    this.pageColumnByX = new Uint32Array(width_);
    this.localXByX = new Uint32Array(width_);
    for (let x = 0; x < width_; x++) {
      const pageX = Math.floor(x / pageSize_);
      this.pageColumnByX[x] = pageX;
      this.localXByX[x] = x - pageX * pageSize_;
    }
    this.pageRowBaseByY = new Uint32Array(height_);
    this.localYByY = new Uint32Array(height_);
    for (let y = 0; y < height_; y++) {
      const pageY = Math.floor(y / pageSize_);
      this.pageRowBaseByY[y] = pageY * this.pagesWide;
      this.localYByY[y] = y - pageY * pageSize_;
    }
    const expectedCount = this.pagesWide * this.pagesHigh;
    if (terrainPages.length !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} terrain pages, received ${terrainPages.length}`,
      );
    }

    const inputByIndex = new Map<number, TerrainPageInput>();
    for (const page of terrainPages) {
      if (
        !Number.isInteger(page.pageX) ||
        !Number.isInteger(page.pageY) ||
        page.pageX < 0 ||
        page.pageX >= this.pagesWide ||
        page.pageY < 0 ||
        page.pageY >= this.pagesHigh
      ) {
        throw new Error(`Invalid page coordinate ${page.pageX},${page.pageY}`);
      }
      const index = page.pageY * this.pagesWide + page.pageX;
      if (inputByIndex.has(index)) {
        throw new Error(
          `Duplicate page coordinate ${page.pageX},${page.pageY}`,
        );
      }
      const expectedWidth = Math.min(
        pageSize_,
        width_ - page.pageX * pageSize_,
      );
      const expectedHeight = Math.min(
        pageSize_,
        height_ - page.pageY * pageSize_,
      );
      if (page.width !== expectedWidth || page.height !== expectedHeight) {
        throw new Error(
          `Page ${page.pageX},${page.pageY} is ${page.width}x${page.height}; expected ${expectedWidth}x${expectedHeight}`,
        );
      }
      if (page.terrain.length !== page.width * page.height) {
        throw new Error(
          `Page ${page.pageX},${page.pageY} terrain length ${page.terrain.length} does not match ${page.width}x${page.height}`,
        );
      }
      inputByIndex.set(index, page);
    }

    this.pages = new Array<InternalTilePage>(expectedCount);
    this.publicPages = new Array<GameMapTilePage>(expectedCount);
    for (let pageY = 0; pageY < this.pagesHigh; pageY++) {
      for (let pageX = 0; pageX < this.pagesWide; pageX++) {
        const index = pageY * this.pagesWide + pageX;
        const input = inputByIndex.get(index);
        if (!input) throw new Error(`Missing page ${pageX},${pageY}`);
        const internal = {
          index,
          pageX,
          pageY,
          originX: pageX * pageSize_,
          originY: pageY * pageSize_,
          width: input.width,
          height: input.height,
          terrain: input.terrain,
          state: null,
        } as InternalTilePage;
        const publicPage = {
          index,
          pageX,
          pageY,
          originX: pageX * pageSize_,
          originY: pageY * pageSize_,
          width: input.width,
          height: input.height,
          terrain: input.terrain,
          get state() {
            return (internal.state ??= new Uint16Array(
              input.width * input.height,
            ));
          },
        } satisfies GameMapTilePage;
        internal.publicPage = publicPage;
        this.pages[index] = internal;
        this.publicPages[index] = publicPage;
      }
    }
  }

  static fromRowMajor(
    width: number,
    height: number,
    pageSize: number,
    terrain: Uint8Array,
    numLandTiles: number,
  ): PagedGameMap {
    if (terrain.length !== width * height) {
      throw new Error(
        `Terrain data length ${terrain.length} doesn't match dimensions ${width}x${height}`,
      );
    }
    const pages: TerrainPageInput[] = [];
    const pagesWide = Math.ceil(width / pageSize);
    const pagesHigh = Math.ceil(height / pageSize);
    for (let pageY = 0; pageY < pagesHigh; pageY++) {
      for (let pageX = 0; pageX < pagesWide; pageX++) {
        const pageWidth = Math.min(pageSize, width - pageX * pageSize);
        const pageHeight = Math.min(pageSize, height - pageY * pageSize);
        const data = new Uint8Array(pageWidth * pageHeight);
        for (let localY = 0; localY < pageHeight; localY++) {
          const sourceOffset =
            (pageY * pageSize + localY) * width + pageX * pageSize;
          data.set(
            terrain.subarray(sourceOffset, sourceOffset + pageWidth),
            localY * pageWidth,
          );
        }
        pages.push({
          pageX,
          pageY,
          width: pageWidth,
          height: pageHeight,
          terrain: data,
        });
      }
    }
    return new PagedGameMap(width, height, pageSize, pages, numLandTiles);
  }

  ref(x: number, y: number): TileRef {
    if (!this.isValidCoord(x, y)) {
      throw new Error(`Invalid coordinates: ${x},${y}`);
    }
    return y * this.width_ + x;
  }

  isValidRef(ref: TileRef): boolean {
    return (
      Number.isSafeInteger(ref) && ref >= 0 && ref < this.width_ * this.height_
    );
  }

  x(ref: TileRef): number {
    return ref % this.width_;
  }

  y(ref: TileRef): number {
    return Math.floor(ref / this.width_);
  }

  cell(ref: TileRef): Cell {
    return new Cell(this.x(ref), this.y(ref));
  }

  width(): number {
    return this.width_;
  }

  height(): number {
    return this.height_;
  }

  pageSize(): number {
    return this.pageSize_;
  }

  pageGrid(): Readonly<{ width: number; height: number }> {
    return { width: this.pagesWide, height: this.pagesHigh };
  }

  numLandTiles(): number {
    return this.landTiles_;
  }

  isValidCoord(x: number, y: number): boolean {
    return (
      Number.isSafeInteger(x) &&
      Number.isSafeInteger(y) &&
      x >= 0 &&
      x < this.width_ &&
      y >= 0 &&
      y < this.height_
    );
  }

  tilePages(): readonly GameMapTilePage[] {
    return this.publicPages;
  }

  tilePageLocation(ref: TileRef) {
    const { page, offset } = this.location(ref);
    return { pageIndex: page.index, offset };
  }

  isPaged(): boolean {
    return true;
  }

  /** Non-allocating fresh-map check for the server's initial storage choice. */
  hasAllocatedState(): boolean {
    return this.pages.some((page) => page.state !== null);
  }

  private location(ref: TileRef): { page: InternalTilePage; offset: number } {
    if (!this.isValidRef(ref)) throw new Error(`Invalid tile ref ${ref}`);
    const x = ref % this.width_;
    const y = (ref - x) / this.width_;
    const page = this.pages[this.pageRowBaseByY[y] + this.pageColumnByX[x]];
    return {
      page,
      offset: this.localYByY[y] * page.width + this.localXByX[x],
    };
  }

  terrainByte(ref: TileRef): number {
    if (!this.isValidRef(ref)) throw new Error(`Invalid tile ref ${ref}`);
    const x = ref % this.width_;
    const y = (ref - x) / this.width_;
    const page = this.pages[this.pageRowBaseByY[y] + this.pageColumnByX[x]];
    return page.terrain[this.localYByY[y] * page.width + this.localXByX[x]];
  }

  private setTerrainByte(ref: TileRef, value: number): void {
    const { page, offset } = this.location(ref);
    if (page.terrain[offset] === value) return;
    page.terrain[offset] = value;
    for (const listener of this.terrainObservers) listener(ref);
  }

  private terrainObservers = new Set<(tile: TileRef) => void>();
  observeTerrain(listener: (tile: TileRef) => void): () => void {
    this.terrainObservers.add(listener);
    return () => this.terrainObservers.delete(listener);
  }

  tileState(ref: TileRef): number {
    if (!this.isValidRef(ref)) throw new Error(`Invalid tile ref ${ref}`);
    const x = ref % this.width_;
    const y = (ref - x) / this.width_;
    const page = this.pages[this.pageRowBaseByY[y] + this.pageColumnByX[x]];
    return (
      page.state?.[this.localYByY[y] * page.width + this.localXByX[x]] ?? 0
    );
  }

  private setTileState(ref: TileRef, value: number): void {
    const { page, offset } = this.location(ref);
    if (value === 0 && page.state === null) return;
    (page.state ??= new Uint16Array(page.width * page.height))[offset] = value;
    this.stateObserver?.(ref);
  }

  isLand(ref: TileRef): boolean {
    return Boolean(this.terrainByte(ref) & (1 << PagedGameMap.IS_LAND_BIT));
  }

  isImpassable(ref: TileRef): boolean {
    const terrain = this.terrainByte(ref);
    return (
      Boolean(terrain & (1 << PagedGameMap.IS_LAND_BIT)) &&
      (terrain & PagedGameMap.MAGNITUDE_MASK) ===
        PagedGameMap.IMPASSABLE_MAGNITUDE
    );
  }

  isOceanShore(ref: TileRef): boolean {
    if (!this.isLand(ref)) return false;
    let ocean = false;
    this.forEachNeighbor(ref, (neighbor) => {
      ocean ||= this.isOcean(neighbor);
    });
    return ocean;
  }

  isOcean(ref: TileRef): boolean {
    return Boolean(this.terrainByte(ref) & (1 << PagedGameMap.OCEAN_BIT));
  }

  isShoreline(ref: TileRef): boolean {
    return Boolean(this.terrainByte(ref) & (1 << PagedGameMap.SHORELINE_BIT));
  }

  magnitude(ref: TileRef): number {
    return this.terrainByte(ref) & PagedGameMap.MAGNITUDE_MASK;
  }

  setWater(ref: TileRef): void {
    if (!this.isLand(ref) || this.isImpassable(ref)) return;
    this.setTerrainByte(ref, 0);
    this.landTiles_--;
  }

  setShorelineBit(ref: TileRef): void {
    this.setTerrainByte(
      ref,
      this.terrainByte(ref) | (1 << PagedGameMap.SHORELINE_BIT),
    );
  }

  clearShorelineBit(ref: TileRef): void {
    this.setTerrainByte(
      ref,
      this.terrainByte(ref) & ~(1 << PagedGameMap.SHORELINE_BIT),
    );
  }

  setOcean(ref: TileRef): void {
    this.setTerrainByte(
      ref,
      this.terrainByte(ref) | (1 << PagedGameMap.OCEAN_BIT),
    );
  }

  setMagnitude(ref: TileRef, value: number): void {
    this.setTerrainByte(
      ref,
      (this.terrainByte(ref) & ~PagedGameMap.MAGNITUDE_MASK) |
        (value & PagedGameMap.MAGNITUDE_MASK),
    );
  }

  ownerID(ref: TileRef): number {
    return this.tileState(ref) & PagedGameMap.PLAYER_ID_MASK;
  }

  hasOwner(ref: TileRef): boolean {
    return this.ownerID(ref) !== 0;
  }

  setOwnerID(ref: TileRef, playerId: number): void {
    if (playerId > PagedGameMap.PLAYER_ID_MASK || playerId < 0) {
      throw new Error(
        `Player ID ${playerId} exceeds maximum value ${PagedGameMap.PLAYER_ID_MASK}`,
      );
    }
    const { page, offset } = this.location(ref);
    if (playerId === 0 && page.state === null) return;
    const state = (page.state ??= new Uint16Array(page.width * page.height));
    state[offset] = (state[offset] & ~PagedGameMap.PLAYER_ID_MASK) | playerId;
    this.stateObserver?.(ref);
  }

  hasFallout(ref: TileRef): boolean {
    return Boolean(this.tileState(ref) & (1 << PagedGameMap.FALLOUT_BIT));
  }

  setFallout(ref: TileRef, value: boolean): void {
    const { page, offset } = this.location(ref);
    const existing = Boolean(
      (page.state?.[offset] ?? 0) & (1 << PagedGameMap.FALLOUT_BIT),
    );
    if (existing === value) return;
    const state = (page.state ??= new Uint16Array(page.width * page.height));
    state[offset] = value
      ? state[offset] | (1 << PagedGameMap.FALLOUT_BIT)
      : state[offset] & ~(1 << PagedGameMap.FALLOUT_BIT);
    this.falloutTiles += value ? 1 : -1;
    this.stateObserver?.(ref);
  }

  hasDefenseBonus(ref: TileRef): boolean {
    return Boolean(this.tileState(ref) & (1 << PagedGameMap.DEFENSE_BONUS_BIT));
  }

  setDefenseBonus(ref: TileRef, value: boolean): void {
    const { page, offset } = this.location(ref);
    if (!value && page.state === null) return;
    const state = (page.state ??= new Uint16Array(page.width * page.height));
    state[offset] = value
      ? state[offset] | (1 << PagedGameMap.DEFENSE_BONUS_BIT)
      : state[offset] & ~(1 << PagedGameMap.DEFENSE_BONUS_BIT);
    this.stateObserver?.(ref);
  }

  isOnEdgeOfMap(ref: TileRef): boolean {
    const x = this.x(ref);
    const y = this.y(ref);
    return (
      x === 0 || x === this.width_ - 1 || y === 0 || y === this.height_ - 1
    );
  }

  isBorder(ref: TileRef): boolean {
    const owner = this.ownerID(ref);
    const width = this.width_;
    const x = ref % width;
    return (
      (ref >= width && this.ownerID(ref - width) !== owner) ||
      (ref < (this.height_ - 1) * width &&
        this.ownerID(ref + width) !== owner) ||
      (x !== 0 && this.ownerID(ref - 1) !== owner) ||
      (x !== width - 1 && this.ownerID(ref + 1) !== owner)
    );
  }

  neighbors(ref: TileRef): TileRef[] {
    const result: TileRef[] = [];
    this.forEachNeighbor(ref, (neighbor) => result.push(neighbor));
    return result;
  }

  forEachNeighbor(ref: TileRef, callback: (neighbor: TileRef) => void): void {
    const width = this.width_;
    const x = ref % width;
    if (ref >= width) callback(ref - width);
    if (ref < (this.height_ - 1) * width) callback(ref + width);
    if (x !== 0) callback(ref - 1);
    if (x !== width - 1) callback(ref + 1);
  }

  neighbors4(ref: TileRef, out: TileRef[]): number {
    let count = 0;
    const width = this.width_;
    const x = ref % width;
    if (ref >= width) out[count++] = ref - width;
    if (ref < (this.height_ - 1) * width) out[count++] = ref + width;
    if (x !== 0) out[count++] = ref - 1;
    if (x !== width - 1) out[count++] = ref + 1;
    return count;
  }

  forEachNeighborWithDiag(
    ref: TileRef,
    callback: (neighbor: TileRef) => void,
  ): void {
    // Preserve the original dx-major order: conquest/AI can depend on it.
    const width = this.width_;
    const x = ref % width;
    const up = ref >= width;
    const down = ref < (this.height_ - 1) * width;
    if (x !== 0) {
      if (up) callback(ref - width - 1);
      callback(ref - 1);
      if (down) callback(ref + width - 1);
    }
    if (up) callback(ref - width);
    if (down) callback(ref + width);
    if (x !== width - 1) {
      if (up) callback(ref - width + 1);
      callback(ref + 1);
      if (down) callback(ref + width + 1);
    }
  }

  isWater(ref: TileRef): boolean {
    return !this.isLand(ref);
  }

  isShore(ref: TileRef): boolean {
    const terrain = this.terrainByte(ref);
    return (
      Boolean(terrain & (1 << PagedGameMap.IS_LAND_BIT)) &&
      Boolean(terrain & (1 << PagedGameMap.SHORELINE_BIT))
    );
  }

  cost(ref: TileRef): number {
    return this.magnitude(ref) < 10 ? 2 : 1;
  }

  terrainType(ref: TileRef): TerrainType {
    const terrain = this.terrainByte(ref);
    if (!(terrain & (1 << PagedGameMap.IS_LAND_BIT))) return TerrainType.Ocean;
    const magnitude = terrain & PagedGameMap.MAGNITUDE_MASK;
    if (magnitude >= PagedGameMap.IMPASSABLE_MAGNITUDE)
      return TerrainType.Impassable;
    if (magnitude < 10) return TerrainType.Plains;
    if (magnitude < 20) return TerrainType.Highland;
    return TerrainType.Mountain;
  }

  forEachTile(fn: (tile: TileRef) => void): void {
    for (let ref = 0; ref < this.width_ * this.height_; ref++) fn(ref);
  }

  manhattanDist(c1: TileRef, c2: TileRef): number {
    return (
      Math.abs(this.x(c1) - this.x(c2)) + Math.abs(this.y(c1) - this.y(c2))
    );
  }

  euclideanDistSquared(c1: TileRef, c2: TileRef): number {
    const dx = this.x(c1) - this.x(c2);
    const dy = this.y(c1) - this.y(c2);
    return dx * dx + dy * dy;
  }

  circleSearch(
    tile: TileRef,
    radius: number,
    filter?: (tile: TileRef, d2: number) => boolean,
  ): Set<TileRef> {
    const centerX = this.x(tile);
    const centerY = this.y(tile);
    const result = new Set<TileRef>();
    const minX = Math.max(0, centerX - radius);
    const maxX = Math.min(this.width_ - 1, centerX + radius);
    const minY = Math.max(0, centerY - radius);
    const maxY = Math.min(this.height_ - 1, centerY + radius);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const ref = y * this.width_ + x;
        const d2 = this.euclideanDistSquared(tile, ref);
        if (d2 <= radius * radius && (!filter || filter(ref, d2)))
          result.add(ref);
      }
    }
    return result;
  }

  bfs(
    tile: TileRef,
    filter: (gm: GameMap, tile: TileRef) => boolean,
  ): Set<TileRef> {
    const seen = new Set<TileRef>();
    const queue: TileRef[] = [];
    if (filter(this, tile)) {
      seen.add(tile);
      queue.push(tile);
    }
    const visit = (candidate: TileRef) => {
      if (!seen.has(candidate) && filter(this, candidate)) {
        seen.add(candidate);
        queue.push(candidate);
      }
    };
    while (queue.length > 0) {
      const current = queue.pop()!;
      this.forEachNeighbor(current, visit);
    }
    return seen;
  }

  tileStateBuffer(): Uint16Array {
    throw new Error(
      "PagedGameMap has no contiguous tile-state buffer; consume tilePages() instead",
    );
  }

  updateTile(ref: TileRef, packed: number): boolean {
    const state = packed & 0xffff;
    const terrain = (packed >>> 16) & 0xff;
    const { page, offset } = this.location(ref);
    const existingState = page.state?.[offset] ?? 0;
    const existingFallout = Boolean(
      existingState & (1 << PagedGameMap.FALLOUT_BIT),
    );
    if (state !== 0 || page.state !== null) {
      (page.state ??= new Uint16Array(page.width * page.height))[offset] =
        state;
    }
    const newFallout = Boolean(state & (1 << PagedGameMap.FALLOUT_BIT));
    if (existingFallout !== newFallout)
      this.falloutTiles += newFallout ? 1 : -1;
    this.stateObserver?.(ref);

    const previousTerrain = page.terrain[offset];
    if (previousTerrain === terrain) return false;
    const wasLand = Boolean(previousTerrain & (1 << PagedGameMap.IS_LAND_BIT));
    const isLand = Boolean(terrain & (1 << PagedGameMap.IS_LAND_BIT));
    page.terrain[offset] = terrain;
    for (const listener of this.terrainObservers) listener(ref);
    if (wasLand !== isLand) this.landTiles_ += isLand ? 1 : -1;
    return true;
  }

  numTilesWithFallout(): number {
    return this.falloutTiles;
  }
}
