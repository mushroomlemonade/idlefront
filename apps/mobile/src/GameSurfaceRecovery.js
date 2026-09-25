/** A late load event must not hide an error from a dead WebContent process. */
export function surfacePhaseAfter(phase, event) {
    if (event === "retry")
        return "connecting";
    if (event === "renderer-stopped")
        return "renderer-stopped";
    if (phase === "renderer-stopped")
        return phase;
    if (event === "network-error")
        return "network-error";
    if (event === "load-start")
        return "connecting";
    return phase === "connecting" ? "live" : phase;
}
/** Never replay a redirect to another origin as a native recovery target. */
export function sameOriginRecoveryUrl(candidate, home) {
    try {
        const url = new URL(candidate);
        return url.origin === new URL(home).origin ? url.href : home;
    }
    catch {
        return home;
    }
}
//# sourceMappingURL=GameSurfaceRecovery.js.map