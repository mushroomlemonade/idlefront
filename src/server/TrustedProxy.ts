import { isIP } from "node:net";

/**
 * Local development connects directly on loopback. In hosting, cloudflared
 * reaches a host-loopback published port and the container trusts its one
 * separately configured bridge gateway below. Direct LAN/public clients are
 * never trusted to supply forwarding headers.
 */
export function isLoopbackProxyAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  if (normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.split(".")[0] === "127";
}

function normalizeAddress(address: string): string {
  const normalized = address.trim().toLowerCase();
  return normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
}

function isPrivateIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

/**
 * Docker port publishing rewrites the host's loopback connection to the
 * isolated bridge gateway. Trust that single configured private address, not
 * the bridge CIDR, so another container cannot choose forwarding headers.
 */
export function createTrustedProxyPredicate(
  containerProxyAddress?: string,
): (address: string) => boolean {
  const configured = containerProxyAddress
    ? normalizeAddress(containerProxyAddress)
    : "";
  if (configured && !isPrivateIpv4(configured)) {
    throw new Error(
      "IDLE_TRUSTED_PROXY_ADDRESS must be one private IPv4 address",
    );
  }
  return (address: string): boolean => {
    if (isLoopbackProxyAddress(address)) return true;
    return Boolean(configured) && normalizeAddress(address) === configured;
  };
}
