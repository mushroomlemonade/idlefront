const DEBUG_MODE_STORAGE_KEY = "idlefront.runtime-debug.v1";

export function resolveRuntimeDebugMode(
  search: string,
  stored: string | null,
  developmentBuild: boolean,
): boolean {
  const requested = new URLSearchParams(search).get("debug");
  if (requested === "1" || requested === "true") return true;
  if (requested === "0" || requested === "false") return false;
  if (stored === "1") return true;
  if (stored === "0") return false;
  return developmentBuild;
}

/**
 * Runtime diagnostics are opt-in in production and on by default in Vite's
 * development server. `?debug=1` enables them for a tunneled/native preview;
 * `?debug=0` is an explicit escape hatch while profiling itself is suspect.
 */
export function runtimeDebugEnabled(): boolean {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY);
  } catch {
    // Sandboxed WebViews can deny storage. The URL/build flag still works.
  }
  return resolveRuntimeDebugMode(
    window.location.search,
    stored,
    import.meta.env.DEV,
  );
}

/**
 * Remember an explicit URL choice before the router removes the query string.
 * This keeps debug telemetry available after a tunneled/native preview enters
 * a game route while leaving normal production sessions untouched.
 */
export function syncRuntimeDebugMode(): boolean {
  const requested = new URLSearchParams(window.location.search).get("debug");
  const enabled = runtimeDebugEnabled();
  if (
    requested === "1" ||
    requested === "true" ||
    requested === "0" ||
    requested === "false"
  ) {
    setRuntimeDebugEnabled(enabled);
  }
  return enabled;
}

export function setRuntimeDebugEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(DEBUG_MODE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Keep the current document usable even when storage is unavailable.
  }
}

export const RUNTIME_DEBUG_MODE_STORAGE_KEY = DEBUG_MODE_STORAGE_KEY;
