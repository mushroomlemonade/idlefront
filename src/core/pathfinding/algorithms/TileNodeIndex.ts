/** Search-local tile -> node index, with O(1) generation resets and no V8 Map
 * allocation per cold route. Values are explicit node IDs; iteration order is
 * irrelevant and never used to choose search neighbors or heap ties. */
export class TileNodeIndex {
  private keys = new Uint32Array(4096);
  private values = new Uint32Array(4096);
  private stamps = new Uint32Array(4096);
  private generation = 1;
  private count = 0;
  private hash(tile: number): number {
    const h = Math.imul(tile, 0x9e3779b1);
    return (h ^ (h >>> 15)) >>> 0;
  }
  clear(): void {
    this.count = 0;
    if (this.keys.length > 2_097_152) {
      this.keys = new Uint32Array(4096);
      this.values = new Uint32Array(4096);
      this.stamps = new Uint32Array(4096);
      this.generation = 1;
    } else if (++this.generation > 0xffffffff) {
      this.stamps.fill(0);
      this.generation = 1;
    }
  }
  get(tile: number): number | undefined {
    const mask = this.keys.length - 1;
    let slot = this.hash(tile) & mask;
    while (this.stamps[slot] === this.generation) {
      if (this.keys[slot] === tile) return this.values[slot];
      slot = (slot + 1) & mask;
    }
    return undefined;
  }
  set(tile: number, value: number): void {
    if ((this.count + 1) * 4 >= this.keys.length * 3) this.grow();
    this.insert(tile, value);
  }
  private insert(tile: number, value: number): void {
    const mask = this.keys.length - 1;
    let slot = this.hash(tile) & mask;
    while (this.stamps[slot] === this.generation) {
      if (this.keys[slot] === tile) {
        this.values[slot] = value;
        return;
      }
      slot = (slot + 1) & mask;
    }
    this.keys[slot] = tile;
    this.values[slot] = value;
    this.stamps[slot] = this.generation;
    this.count++;
  }
  private grow(): void {
    const keys = this.keys,
      values = this.values,
      stamps = this.stamps;
    this.keys = new Uint32Array(keys.length * 2);
    this.values = new Uint32Array(keys.length * 2);
    this.stamps = new Uint32Array(keys.length * 2);
    this.count = 0;
    for (let i = 0; i < keys.length; i++)
      if (stamps[i] === this.generation) this.insert(keys[i], values[i]);
  }
}
