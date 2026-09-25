import fs from "fs";
import path from "path";

const repoRoot = process.cwd();

function source(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("IdleFront stone button specimen deck", () => {
  const lab = source("src/client/components/AtlasUiLab.ts");
  const styles = source("src/client/styles/stone-button-specimen.css");
  const skins = source("src/client/styles/stone-controls.css");
  const baseStyles = source("src/client/styles/war-room.css");
  const satisfum = source("src/client/styles/satisfum.css");
  const main = source("src/client/Main.ts");

  test("is available only through a dedicated UI-lab screen", () => {
    expect(lab).toContain('const STONE_BUTTON_LAB = "stone-buttons"');
    expect(lab).toContain('href="?ui-lab=${STONE_BUTTON_LAB}"');
    expect(lab).toContain('aria-label="IdleFront stone button laboratory"');
    expect(lab).not.toContain('import "./StoneButton"');
    expect(lab).not.toContain("<idlefront-stone-button");
  });

  test("starts from the proven native control and adds five texture copies", () => {
    expect(lab).toContain(
      'class="atlas-war-button atlas-texture-demo__button"',
    );
    expect(lab).toContain("Original control");
    expect(lab).toContain("The same button underneath");

    for (const variant of [
      "quartz",
      "obsidian",
      "amethyst",
      "ruby",
      "emerald",
    ]) {
      expect(lab).toContain(`variant: "${variant}"`);
      expect(skins).toContain(`/images/ui/materials/stones/${variant}.webp`);
    }
  });

  test("changes only the existing button texture plane", () => {
    expect(skins).toContain(
      '.atlas-war-button[data-stone]:not([data-stone="none"])::after',
    );
    expect(skins).toContain("var(--atlas-stone-texture)");
    expect(skins).not.toContain(":hover");
    expect(skins).not.toContain(":active");
    expect(baseStyles).toContain('@import "./stone-controls.css"');
    expect(styles).not.toContain(".atlas-texture-demo__button:hover");
    expect(styles).not.toContain(".atlas-texture-demo__button:active");
    expect(styles).not.toContain("@stone-toggle-request");
    expect(lab).not.toContain("@click=");
  });

  test("keeps the proven hover and native press choreography in one place", () => {
    expect(baseStyles).toContain(".atlas-war-button:hover:not(:disabled)");
    expect(baseStyles).toContain(".atlas-war-button:active:not(:disabled)");
    expect(baseStyles).toContain("100% 200% !important");
    expect(baseStyles).toContain("center bottom !important");
    expect(baseStyles).toContain(
      "transform: translateY(2px) scale(0.995) !important",
    );
    expect(baseStyles).toContain("translateY(58%) scaleY(-0.76)");
  });

  test("uses a single full-screen, non-scrolling comparison surface", () => {
    expect(styles).toContain("height: 100dvh");
    expect(styles).toContain("overflow: hidden");
    expect(styles).not.toContain("scroll-snap-type");
    expect(styles).not.toContain("overflow-x: auto");
    expect(styles).toContain("env(safe-area-inset-top)");
    expect(styles).toContain("prefers-reduced-motion: reduce");
  });

  test("uses the high-resolution stone maps already in the project", () => {
    for (const variant of [
      "quartz",
      "obsidian",
      "amethyst",
      "ruby",
      "emerald",
    ]) {
      const asset = path.join(
        repoRoot,
        `resources/images/ui/materials/stones/${variant}.webp`,
      );
      expect(fs.existsSync(asset)).toBe(true);
      expect(fs.statSync(asset).size).toBeGreaterThan(150_000);
      expect(fs.readFileSync(asset).subarray(0, 4).toString("ascii")).toBe(
        "RIFF",
      );
    }
  });

  test("keeps the base material lab inside a full-screen specimen workspace", () => {
    expect(lab).toContain('class="atlas-ui-lab__workspace"');
    expect(baseStyles).toContain(".atlas-ui-lab__workspace {");
    expect(baseStyles).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(baseStyles).toContain("scroll-snap-type: x mandatory");
    expect(baseStyles).toContain("body.atlas-ui-lab-active {");
    expect(baseStyles).toContain("overflow: hidden !important");
  });

  test("reuses the specimen stones across production controls and settings", () => {
    expect(main).toContain('import "./styles/satisfum.css"');
    expect(main.indexOf('import "./styles/satisfum.css"')).toBeGreaterThan(
      main.indexOf('import "./styles/war-room.css"'),
    );
    expect(satisfum).toContain("--sf-quartz:");
    expect(satisfum).toContain("--sf-obsidian:");
    expect(satisfum).toContain("--sf-amethyst:");
    expect(satisfum).toContain("--sf-ruby:");
    expect(satisfum).toContain("--sf-emerald:");
    expect(satisfum).toContain(".atlas-settings-list button");
    expect(satisfum).toContain('input[type="range"]::-webkit-slider-thumb');
    expect(satisfum).toContain('input[type="range"]::-moz-range-thumb');
    expect(satisfum).toContain(":where(#app, canvas, map-display)");
  });

  test("keeps every large photographic substrate retina-ready", () => {
    for (const material of ["mahogany", "parchment"]) {
      const asset = path.join(
        repoRoot,
        `resources/images/ui/materials/${material}@4x.webp`,
      );
      expect(fs.existsSync(asset)).toBe(true);
      expect(fs.statSync(asset).size).toBeGreaterThan(80_000);
      expect(fs.readFileSync(asset).subarray(0, 4).toString("ascii")).toBe(
        "RIFF",
      );
      expect(baseStyles).toContain(`${material}@4x.webp`);
    }

    expect(satisfum).toContain("418px 418px");
  });

  test("composes material content into one surface instead of duplicating it", async () => {
    await import("../../src/client/components/AtlasPrimitives");
    const surface = document.createElement("atlas-surface");
    const label = document.createElement("span");
    label.textContent = "Material specimen";
    surface.append(label);
    document.body.append(surface);
    await Promise.resolve();

    expect(surface.children).toHaveLength(1);
    const face = surface.firstElementChild as HTMLElement;
    expect(face.dataset.atlasSurfaceRoot).toBe("");
    expect(face.classList).toContain("atlas-material-surface");
    expect(face.textContent).toBe("Material specimen");
    surface.remove();
  });
});
