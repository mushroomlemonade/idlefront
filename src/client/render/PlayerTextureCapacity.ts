const MIN_FLAT_MAP_CAPACITY = 1024;
const MIN_PAGED_MAP_CAPACITY = 4096;
const MAX_OWNER_CAPACITY = 4096;

function nonNegativeInteger(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.ceil(value));
}

function nextPowerOfTwo(value: number): number {
  let capacity = 1;
  while (capacity < value) capacity *= 2;
  return capacity;
}

/**
 * Static renderer textures must cover the complete simulation roster. Bots are
 * registered after construction, so sizing from the initially connected human
 * players alone can let a valid authoritative frame overflow the name buffers.
 */
export function playerTextureCapacity(
  botCount: number,
  humanCapacity: number | undefined,
  pagedMap: boolean,
): number {
  const minimum = pagedMap ? MIN_PAGED_MAP_CAPACITY : MIN_FLAT_MAP_CAPACITY;
  const rosterSize =
    nonNegativeInteger(botCount) + nonNegativeInteger(humanCapacity);

  return Math.min(
    MAX_OWNER_CAPACITY,
    Math.max(minimum, nextPowerOfTwo(Math.max(1, rosterSize))),
  );
}
