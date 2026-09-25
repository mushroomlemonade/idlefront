import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

describe("standalone fork license compliance", () => {
  it("keeps OpenFront's AGPL additional terms intact", () => {
    const license = read("LICENSE");
    expect(license).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(license).toContain("© OpenFront and Contributors");
    expect(license).toContain("Prohibition of Misrepresentation");
  });

  it("offers corresponding source and the appropriate legal notices", () => {
    const notice = read("NOTICE.md");
    const page = read("src/client/components/LegalNoticePage.ts");
    const sourceLinks = read("src/client/SourceLinks.ts");
    const drawer = read("src/client/components/MobileNavBar.ts");

    for (const source of [notice, page, drawer]) {
      expect(source).toContain("© OpenFront and Contributors");
    }
    expect(page).toContain("provided without");
    expect(page).toContain("correspondingSourceUrl()");
    expect(sourceLinks).toContain(
      "https://github.com/mushroomlemonade/idlefront",
    );
    expect(sourceLinks).toContain("ClientEnv.gitCommit()");
    expect(drawer).toContain('data-page="page-legal"');
  });

  it("never connects the fork to OpenFront hosted services or ad properties", () => {
    const packageJson = read("package.json");
    const main = read("src/client/Main.ts");
    const store = read("src/client/Store.ts");
    const deployment = read(".github/workflows/deploy.yml");
    const dockerfile = read("Dockerfile");

    expect(packageJson).not.toMatch(/api\.openfront\.(?:io|dev)/);
    expect(main).toContain("window.adsEnabled = false");
    expect(main).not.toMatch(/loadAdmiral|onAdmiralMeasured|adGatekeeper/);
    expect(store).not.toMatch(/https?:\/\/[^\s"']*openfront\.(?:io|dev)/);
    expect(deployment).not.toMatch(/openfront\.(?:io|dev)/);
    expect(dockerfile).not.toMatch(/openfront\.(?:io|dev)/);
  });

  it("does not ship or load the restricted proprietary asset directory", () => {
    expect(fs.existsSync(path.join(root, "proprietary"))).toBe(false);

    const runtimeFiles = [
      "Dockerfile",
      "index.html",
      "vite.config.ts",
      "src/client/Main.ts",
      "src/client/sound/SoundManager.ts",
      "src/server/RenderHtml.ts",
    ];
    for (const file of runtimeFiles) {
      expect(read(file)).not.toMatch(
        /COPY proprietary|getProprietaryDir|OpenFront\.ttf|sounds\/music\/(?:of4|openfront|war)\.mp3/,
      );
    }
  });
});
