const PAGE_SHIFT = 10;
const PAGE_SIZE = 1 << PAGE_SHIFT;
const PAGE_MASK = PAGE_SIZE - 1;

/** Only live trail tiles need reference counts, not every tile in the world. */
export class TrailClaims {
  private readonly pages = new Map<
    number,
    { counts: Uint32Array; occupied: number }
  >();

  get allocatedBytes(): number {
    return this.pages.size * PAGE_SIZE * Uint32Array.BYTES_PER_ELEMENT;
  }

  claim(ref: number): void {
    const index = ref >>> PAGE_SHIFT;
    let page = this.pages.get(index);
    if (!page) {
      page = { counts: new Uint32Array(PAGE_SIZE), occupied: 0 };
      this.pages.set(index, page);
    }
    const offset = ref & PAGE_MASK;
    if (page.counts[offset]++ === 0) page.occupied++;
  }

  /** True when no surviving trail owns this tile. Empty pages are reclaimed. */
  release(ref: number): boolean {
    const index = ref >>> PAGE_SHIFT;
    const page = this.pages.get(index);
    const offset = ref & PAGE_MASK;
    if (!page || page.counts[offset] === 0) return true;
    if (--page.counts[offset] !== 0) return false;
    if (--page.occupied === 0) this.pages.delete(index);
    return true;
  }

  clear(): void {
    this.pages.clear();
  }
}
