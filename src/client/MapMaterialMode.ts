const MAP_MATERIAL_STORAGE_KEY = "idlefront.map-material.v1";

export function resolveMapMaterialMode(
  search: string,
  stored: string | null,
): boolean {
  const requested = new URLSearchParams(search).get("map-material");
  if (requested === "mineral") return true;
  if (requested === "classic") return false;
  return stored === "mineral";
}

export function mapMaterialEnabled(): boolean {
  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(MAP_MATERIAL_STORAGE_KEY);
  } catch {
    // Sandboxed WebViews can deny storage. The URL flag remains sufficient.
  }
  return resolveMapMaterialMode(window.location.search, stored);
}

/**
 * Persist an explicit renderer choice before the application router removes
 * the query string. Session storage deliberately scopes the experiment to one
 * browser tab; it never enters replay, simulation, or network state.
 */
export function syncMapMaterialMode(): boolean {
  const requested = new URLSearchParams(window.location.search).get(
    "map-material",
  );
  const enabled = mapMaterialEnabled();

  if (requested === "mineral" || requested === "classic") {
    try {
      if (enabled) {
        window.sessionStorage.setItem(MAP_MATERIAL_STORAGE_KEY, "mineral");
      } else {
        window.sessionStorage.removeItem(MAP_MATERIAL_STORAGE_KEY);
      }
    } catch {
      // Keep the current document usable even when storage is unavailable.
    }
  }
  return enabled;
}

export const MAP_MATERIAL_MODE_STORAGE_KEY = MAP_MATERIAL_STORAGE_KEY;
