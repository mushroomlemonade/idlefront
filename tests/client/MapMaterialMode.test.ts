import {
  MAP_MATERIAL_MODE_STORAGE_KEY,
  mapMaterialEnabled,
  resolveMapMaterialMode,
  syncMapMaterialMode,
} from "../../src/client/MapMaterialMode";

describe("map material mode", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    window.sessionStorage.clear();
  });

  it("is disabled unless the tab opts into the mineral renderer", () => {
    expect(resolveMapMaterialMode("", null)).toBe(false);
    expect(resolveMapMaterialMode("?map-material=mineral", null)).toBe(true);
  });

  it("persists mineral mode across menu and lobby URL transitions", () => {
    window.history.replaceState(null, "", "/?map-material=mineral");
    expect(syncMapMaterialMode()).toBe(true);

    window.history.replaceState(null, "", "/worlds");
    expect(mapMaterialEnabled()).toBe(true);
    expect(window.sessionStorage.getItem(MAP_MATERIAL_MODE_STORAGE_KEY)).toBe(
      "mineral",
    );
  });

  it("supports an explicit classic escape hatch", () => {
    window.sessionStorage.setItem(MAP_MATERIAL_MODE_STORAGE_KEY, "mineral");
    window.history.replaceState(null, "", "/?map-material=classic");

    expect(syncMapMaterialMode()).toBe(false);
    expect(window.sessionStorage.getItem(MAP_MATERIAL_MODE_STORAGE_KEY)).toBe(
      null,
    );
  });
});
