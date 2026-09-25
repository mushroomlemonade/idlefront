import { describe, expect, test } from "vitest";
import { getStaticAssetCacheControl } from "../../src/server/StaticAssetCache";

describe("StaticAssetCache", () => {
  test("marks Vite asset namespace as immutable", () => {
    expect(getStaticAssetCacheControl("/assets/index-abc123.js")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  test("marks custom hashed asset namespace as immutable", () => {
    expect(
      getStaticAssetCacheControl("/_assets/maps/world/manifest.hash.json"),
    ).toBe("public, max-age=31536000, immutable");
  });

  test("revalidates the unversioned standalone idle client", () => {
    expect(getStaticAssetCacheControl("/idle/index.html")).toBe("no-cache");
    expect(getStaticAssetCacheControl("/idle/app.js?v=1")).toBe("no-cache");
  });

  test("does not mark other paths as immutable", () => {
    expect(getStaticAssetCacheControl("/manifest.json")).toBeUndefined();
    expect(getStaticAssetCacheControl("/api/health")).toBeUndefined();
  });
});
