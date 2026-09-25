export type SurfacePhase =
  "connecting" | "live" | "network-error" | "renderer-stopped";

export type SurfaceEvent =
  "load-start" | "load-end" | "network-error" | "renderer-stopped" | "retry";

/** A late load event must not hide an error from a dead WebContent process. */
export function surfacePhaseAfter(
  phase: SurfacePhase,
  event: SurfaceEvent,
): SurfacePhase {
  if (event === "retry") return "connecting";
  if (event === "renderer-stopped") return "renderer-stopped";
  if (phase === "renderer-stopped") return phase;
  if (event === "network-error") return "network-error";
  if (event === "load-start") return "connecting";
  return phase === "connecting" ? "live" : phase;
}

/** Never replay a redirect to another origin as a native recovery target. */
export function sameOriginRecoveryUrl(candidate: string, home: string): string {
  try {
    const url = new URL(candidate);
    return url.origin === new URL(home).origin ? url.href : home;
  } catch {
    return home;
  }
}
