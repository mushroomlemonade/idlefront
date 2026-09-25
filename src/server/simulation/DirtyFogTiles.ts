/** Sparse bit pages bound large reveals without a JS Set entry per tile. */
export class DirtyFogTiles {
  private pages = new Map<number, Uint32Array>();
  private count = 0;
  add(tile: number): void {
    const index = Math.floor(tile / 4096);
    let page = this.pages.get(index);
    if (!page) this.pages.set(index, (page = new Uint32Array(128)));
    const offset = tile % 4096,
      word = offset >>> 5,
      bit = 1 << (offset & 31);
    if (!(page[word] & bit)) {
      page[word] |= bit;
      this.count++;
    }
  }
  drain(): Uint32Array {
    const result = new Uint32Array(this.count);
    let cursor = 0;
    for (const index of [...this.pages.keys()].sort((a, b) => a - b)) {
      const page = this.pages.get(index)!;
      for (let word = 0; word < page.length; word++) {
        let bits = page[word];
        while (bits) {
          result[cursor++] =
            index * 4096 + word * 32 + 31 - Math.clz32(bits & -bits);
          bits = (bits & (bits - 1)) >>> 0;
        }
      }
    }
    this.pages.clear();
    this.count = 0;
    return result;
  }
}
