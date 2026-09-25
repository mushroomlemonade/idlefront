import fs from "fs";
import path from "path";

const repoRoot = process.cwd();

function source(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("Pressure Atlas OpenFront shell", () => {
  test("keeps the canonical OpenFront renderer and HUD mount points", () => {
    const document = source("index.html");
    const hudDeck = source("src/client/components/AtlasGameHud.ts");

    expect(document).toContain('<div id="app"></div>');
    expect(document).toContain(
      '<script type="module" src="/src/client/Main.ts"',
    );
    expect(document).toContain("<atlas-game-hud>");
    expect(hudDeck).toContain("<control-panel");
    expect(hudDeck).toContain("<game-right-sidebar");
    expect(hudDeck).toContain("<game-left-sidebar");
  });

  test("uses the existing lobby entry flow rather than a replacement map", () => {
    const playPage = source("src/client/components/PlayPage.ts");
    const clientRunner = source("src/client/ClientGameRunner.ts");

    expect(playPage).toContain("<username-input");
    expect(playPage).toContain("<game-mode-selector>");
    expect(playPage).not.toContain('class="territory"');
    expect(clientRunner).toContain("createWebGLView");
    expect(clientRunner).toContain('inputOverlay.id = "game-input-overlay"');
  });

  test("redirects legacy idle preview bookmarks to the real client", () => {
    const viteConfig = source("vite.config.ts");

    expect(viteConfig).toContain("legacyIdlePreviewRedirect");
    expect(viteConfig).toContain('pathname !== "/idle/index.html"');
    expect(viteConfig).toContain('Location: "/"');
    expect(viteConfig).not.toContain("idleStandaloneDocument");
  });

  test("keeps the renderer edge-to-edge without a decorative bezel", () => {
    const document = source("index.html");
    const warRoomStyles = source("src/client/styles/war-room.css");

    expect(document).toContain('<div id="app"></div>');
    expect(document).not.toContain("atlas-map-bezel");
    expect(warRoomStyles).not.toContain("atlas-map-bezel");
  });

  test("reserves a Dynamic Island lane above selected-player information", () => {
    const nativeApp = source("apps/mobile/App.tsx");
    const hudDeck = source("src/client/components/AtlasGameHud.ts");
    const playerInfo = source("src/client/hud/layers/PlayerInfoOverlay.ts");
    const spawnTimer = source("src/client/hud/layers/SpawnTimer.ts");
    const styles = source("src/client/styles/war-room.css");

    expect(nativeApp).toContain('<StatusBar animated style="light" />');
    expect(nativeApp).not.toContain("<StatusBar hidden");
    expect(hudDeck).toContain("atlas-hud-top-actions");
    expect(hudDeck).toContain("data-player-info-visible");
    expect(playerInfo).toContain("atlas-player-info-positioner");
    expect(playerInfo).toContain("atlas-player-info-close");
    expect(playerInfo).toContain("atlas-player-info-visibility");
    expect(playerInfo).toContain("!this._isInfoVisible");
    expect(playerInfo).not.toContain("opacity-0 invisible");
    expect(spawnTimer).toContain("--atlas-board-safe-top");
    expect(styles).toContain("--atlas-hud-information-top");
    expect(styles).toContain("--atlas-hud-edge-gap: 6px");
    expect(styles).not.toContain("calc(var(--atlas-board-safe-top) + 0.4rem)");
    expect(styles).toContain("atlas-game-hud[data-player-info-visible]");
  });

  test("consolidates repeated HTML mounts into reusable page and HUD decks", () => {
    const document = source("index.html");
    const pageDeck = source("src/client/components/AtlasPageDeck.ts");
    const rootCustomElements = [
      ...new Set(
        [...document.matchAll(/<([a-z][a-z0-9-]*-[a-z0-9-]+)/g)].map(
          (match) => match[1],
        ),
      ),
    ].sort();

    expect(document).toContain('<atlas-page-deck class="contents">');
    expect(document).toContain("<atlas-game-hud>");
    expect(document).not.toContain("<page-footer>");
    expect(document).not.toContain("<matchmaking-modal");
    expect(document).not.toContain("<control-panel");
    expect(pageDeck).toContain('id="page-settings"');
    expect(pageDeck).toContain('id="page-account"');
    expect(rootCustomElements).toEqual([
      "atlas-game-hud",
      "atlas-global-overlays",
      "atlas-page-deck",
      "desktop-nav-bar",
      "main-layout",
      "mobile-nav-bar",
      "play-page",
    ]);
  });

  test("keeps the title screen free of marketing-page sections", () => {
    const playPage = source("src/client/components/PlayPage.ts");
    const mainLayout = source("src/client/components/MainLayout.ts");

    expect(playPage).toContain('class="atlas-title-stage"');
    expect(playPage).not.toContain("atlas-intro-copy");
    expect(playPage).not.toContain("atlas-field-note");
    expect(playPage).not.toContain("atlas-feature-row");
    expect(mainLayout).toContain("overflow-hidden");
    expect(mainLayout).not.toContain("overflow-y-auto");
  });

  test("presents one headerless Play action that opens a separate Worlds scene", () => {
    const playPage = source("src/client/components/PlayPage.ts");
    const modeSelector = source("src/client/GameModeSelector.ts");
    const worldStyles = source("src/client/styles/persistent-world.css");

    expect(playPage).not.toContain("<header");
    expect(playPage).not.toContain("hamburger-btn");
    expect(modeSelector.match(/class="atlas-quick-play /g)).toHaveLength(1);
    expect(modeSelector).not.toContain("atlas-public-lobbies");
    expect(modeSelector).not.toContain("atlas-game-actions");
    expect(modeSelector).toContain('"/worlds"');
    expect(modeSelector).toContain('"page-persistent-worlds"');
    expect(worldStyles).toContain("persistent-world-page.hidden");
    expect(worldStyles).toContain(
      'body:not([data-page="page-persistent-worlds"]) persistent-world-page',
    );
  });

  test("never offers Add to Home Screen inside the native shell", () => {
    const banner = source("src/client/components/IOSAddToHomeScreenBanner.ts");
    const nativeBridge = source("apps/mobile/src/config/game.ts");
    const renderMethod = banner.slice(banner.indexOf("  render() {"));

    expect(nativeBridge).toContain("window.__PRESSURE_ATLAS_NATIVE__");
    expect(banner).toContain(".__PRESSURE_ATLAS_NATIVE__");
    expect(renderMethod.indexOf(".__PRESSURE_ATLAS_NATIVE__")).toBeLessThan(
      renderMethod.indexOf("return html`"),
    );
  });

  test("keeps the native game surface full-screen and free of global controls", () => {
    const mobileSurface = source("apps/mobile/src/GameSurface.tsx");
    const nativeBridge = source("apps/mobile/src/config/game.ts");
    const document = source("index.html");

    expect(mobileSurface).toContain("<WebView");
    expect(mobileSurface).toContain("flex: 1");
    expect(mobileSurface).not.toContain("NativeDeck");
    expect(mobileSurface).not.toContain("LiquidGlassButton");
    expect(mobileSurface).not.toContain("deckVisible");
    expect(mobileSurface).toContain("allowsBackForwardNavigationGestures");
    expect(mobileSurface).toContain('"hardwareBackPress"');
    expect(mobileSurface).toContain("scalesPageToFit={false}");
    expect(mobileSurface).toContain("setBuiltInZoomControls={false}");
    expect(mobileSurface).toContain("setDisplayZoomControls={false}");
    expect(mobileSurface).toContain("textZoom={100}");
    expect(nativeBridge).toContain("maximum-scale=1");
    expect(document).toContain("maximum-scale=1");
    expect(document).toContain("font-size: max(16px, 1em) !important;");
  });

  test("keeps the hidden developer trigger on the world map logo", () => {
    const mapSidebar = source("src/client/hud/layers/GameLeftSidebar.ts");
    const landingWordmark = source("src/client/components/ProductWordmark.ts");
    const worldWordmark = source(
      "src/client/components/persistent-world/PersistentWorldComponents.ts",
    );
    const styles = source("src/client/styles/war-room.css");

    expect(mapSidebar).toContain("onLogoTap");
    expect(mapSidebar).toContain("recordDeveloperMenuLogoTap");
    expect(mapSidebar).toContain("@pointerup=${this.onLogoTap}");
    expect(landingWordmark).not.toContain("recordDeveloperMenuLogoTap");
    expect(worldWordmark).not.toContain("recordDeveloperMenuLogoTap");
    expect(styles).toMatch(/\.atlas-map-brand-mark\s*\{[^}]*cursor: default;/s);
    expect(styles).toContain("@keyframes atlas-dev-unlock-ring");
  });

  test("applies the Dynamic Island inset once at the scene boundary", () => {
    const document = source("index.html");
    const baseStyles = source("src/client/styles.css");
    const warRoomStyles = source("src/client/styles/war-room.css");

    expect(document).toContain("--atlas-safe-top: max(");
    expect(document).not.toContain("padding-top: max(env(safe-area-inset-top)");
    expect(baseStyles).not.toMatch(
      /body\s*\{[^}]*padding:\s*env\(safe-area-inset-top\)/s,
    );
    expect(warRoomStyles).toContain(
      "calc(3.75rem + var(--atlas-safe-top, 0px))",
    );
  });

  test("keeps product styles away from renderer-owned selectors", () => {
    for (const stylesheet of [
      "src/client/styles/pressure-atlas.css",
      "src/client/styles/war-room.css",
      "src/client/styles/persistent-world.css",
    ]) {
      const cssWithoutComments = source(stylesheet).replace(
        /\/\*[\s\S]*?\*\//g,
        "",
      );
      expect(cssWithoutComments).not.toMatch(
        /(?:^|[},])\s*(?:#app|canvas|map-display)\b/m,
      );
    }
  });

  test("ships local retina material assets rather than remote dependencies", () => {
    for (const asset of [
      "resources/images/ui/materials/mahogany@2x.webp",
      "resources/images/ui/materials/felt@2x.webp",
      "resources/images/ui/materials/felt@4x.webp",
      "resources/images/ui/materials/leather@4x.webp",
      "resources/images/ui/materials/parchment@2x.webp",
    ]) {
      expect(fs.statSync(path.join(repoRoot, asset)).size).toBeGreaterThan(512);
    }

    const warRoomStyles = source("src/client/styles/war-room.css");
    expect(warRoomStyles).toContain("--war-mahogany-texture");
    expect(warRoomStyles).toContain(
      '--war-felt-texture: url("/resources/images/ui/materials/felt@4x.webp")',
    );
    expect(warRoomStyles).toContain(
      '--war-leather-texture: url("/resources/images/ui/materials/leather@4x.webp")',
    );
    expect(warRoomStyles).toContain("--war-parchment-texture");
  });

  test("provides adaptive UI fidelity without coupling it to game rendering", () => {
    const uiRuntime = source("src/client/ui/WarRoomUI.ts");

    expect(uiRuntime).toContain('export type UiFidelity = "full"');
    expect(uiRuntime).toContain("data-ui-fidelity");
    expect(uiRuntime).toContain("prefers-reduced-motion: reduce");
    expect(uiRuntime).not.toMatch(
      /ClientGameRunner|createWebGLView|GameRenderer/,
    );
  });

  test("presents IdleFront as the product while retaining upstream attribution", () => {
    const document = source("index.html");
    const wordmark = source("src/client/components/ProductWordmark.ts");
    const playPage = source("src/client/components/PlayPage.ts");
    const worldPage = source(
      "src/client/components/persistent-world/PersistentWorldPage.ts",
    );
    const wizard = source(
      "src/client/components/persistent-world/PersistentWorldCreationWizard.ts",
    );
    const legal = source("src/client/components/LegalNoticePage.ts");
    const language = source("src/client/LangSelector.ts");

    expect(document).toContain(
      "<title>IdleFront — Persistent Strategy</title>",
    );
    expect(document).toContain('data-product="idlefront"');
    expect(wordmark).toContain('aria-label="IdleFront"');
    expect(wordmark).toContain("<span>Idle</span><span>Front</span>");
    expect(playPage).not.toContain("Pressure Atlas");
    expect(worldPage).not.toMatch(/Pressure Atlas|OpenFront/);
    expect(wizard).not.toMatch(/Pressure Atlas|OpenFront/);
    expect(language).toContain('document.body.dataset.product === "idlefront"');
    expect(legal).toContain(
      "IdleFront is an independent modification of OpenFront",
    );
    expect(legal).toContain("© OpenFront and Contributors");
    expect(playPage).toContain("© OpenFront and Contributors");
    expect(playPage).toContain("Independent modification");
    expect(playPage).toContain("correspondingSourceUrl()");
  });

  test("keeps unfinished product prose in a centralized copywriter handoff", () => {
    const copy = source("src/client/copy/PlaceholderCopy.ts");
    const handoff = source("docs/COPYWRITING.md");
    const playPage = source("src/client/components/PlayPage.ts");
    const worldPage = source(
      "src/client/components/persistent-world/PersistentWorldPage.ts",
    );
    const wizard = source(
      "src/client/components/persistent-world/PersistentWorldCreationWizard.ts",
    );

    expect(copy).toContain('subtitle: "online world domination"');
    expect(copy).toContain('heading: "welcome to idlefront"');
    expect(copy).toContain('stepInstructions: "Step instructions"');
    expect(playPage).toContain("placeholderCopy.landing.identityLabel");
    expect(worldPage).toContain("placeholderCopy.worlds.heading");
    expect(wizard).toContain("placeholderCopy.wizard.stepInstructions");
    expect(handoff).toContain("copyright, source, license, attribution");
  });

  test("keeps inherited promotions out of the IdleFront customer journey", () => {
    const navigation = source("src/client/components/MobileNavBar.ts");
    const store = source("src/client/Store.ts");
    const winModal = source("src/client/hud/layers/WinModal.ts");

    expect(navigation).not.toContain('"page-news"');
    expect(store).not.toContain(
      '{ key: "merch", label: translateText("store.merch") }',
    );
    expect(winModal).not.toContain("<steam-wishlist");
    expect(winModal).not.toContain("discord.com/invite/openfront");
  });

  test("builds tactile buttons from glaze, texture, edge depth, and press motion", () => {
    const warRoomStyles = source("src/client/styles/war-room.css");
    const worldStyles = source("src/client/styles/persistent-world.css");

    expect(warRoomStyles).toContain(".atlas-quick-play::before");
    expect(warRoomStyles).toContain("--war-gem-amethyst-face");
    expect(warRoomStyles).toContain("--war-gem-quartz-face");
    expect(warRoomStyles).toContain("--war-gem-ruby-face");
    expect(warRoomStyles).toContain("var(--war-leather-texture)");
    expect(warRoomStyles).toContain("background-blend-mode");
    expect(warRoomStyles).toContain("background-position 210ms");
    expect(warRoomStyles).toContain(
      ".atlas-quick-play:active:not(:disabled)::before",
    );
    expect(warRoomStyles).toContain(
      ".atlas-quick-play:active:not(:disabled) .atlas-quick-play__icon",
    );
    expect(worldStyles).toContain(".pw-button::before");
    expect(worldStyles).toContain(
      "--pw-gem-face: var(--war-gem-amethyst-face)",
    );
    expect(worldStyles).toContain("--pw-gem-face: var(--war-gem-quartz-face)");
    expect(worldStyles).toContain("--pw-gem-face: var(--war-gem-ruby-face)");
    expect(worldStyles).toContain("border-bottom-width: 3px");
    expect(worldStyles).toContain("background-position 210ms");
    expect(worldStyles).toContain(
      ".pw-button:active:not(:disabled) .pw-button__medallion",
    );
  });

  test("makes the world-setup breadcrumb directly navigable", () => {
    const wizard = source(
      "src/client/components/persistent-world/PersistentWorldCreationWizard.ts",
    );

    expect(wizard).toContain('class="pw-wizard__step"');
    expect(wizard).toContain('aria-current=${index === this.step ? "step"');
    expect(wizard).toContain("?disabled=${!this.canOpenStep(index)}");
    expect(wizard).toContain("@click=${() => this.openStep(index)}");
    expect(wizard).toContain("private hasValidSchedule()");
  });

  test("teaches the in-game quick-chat catalog with the same category/phrase layout", () => {
    const lobbyChat = source(
      "src/client/components/persistent-world/PersistentWorldComponents.ts",
    );
    const gameChat = source("src/client/hud/layers/ChatModal.ts");

    expect(lobbyChat).toContain(
      'import quickChatData from "resources/QuickChat.json"',
    );
    expect(gameChat).toContain(
      'import quickChatData from "resources/QuickChat.json"',
    );
    expect(lobbyChat).toContain('${translateText("chat.category")}');
    expect(lobbyChat).toContain('${translateText("chat.phrase")}');
    expect(lobbyChat).toContain('translateText("chat.build")');
    expect(lobbyChat).toContain('translateText("chat.send")');
    expect(lobbyChat).toContain("private selectedPhraseKey");
    expect(lobbyChat).toContain("placeholderCopy.lobby.chatHint");
  });

  test("uses a quiet header instrument instead of overlaying toast popups", () => {
    const worldPage = source(
      "src/client/components/persistent-world/PersistentWorldPage.ts",
    );
    const worldComponents = source(
      "src/client/components/persistent-world/PersistentWorldComponents.ts",
    );
    const worldStyles = source("src/client/styles/persistent-world.css");

    expect(worldPage).toContain('class="pw-header-signal');
    expect(worldPage).toContain('class="pw-header-signal__board"');
    expect(worldPage).toContain('class="pw-header-signal__viewport"');
    expect(worldPage).toContain('class="pw-header-signal__glyph');
    expect(worldPage).not.toContain("statusLabel");
    expect(worldPage).toContain("keyed(");
    expect(worldPage).toContain('role=${statusTone === "error" ? "alert"');
    expect(worldPage).toContain("@world-share-status=${this.shareStatus}");
    expect(worldComponents).toContain('new CustomEvent("world-share-status"');
    expect(worldComponents).not.toContain("copyState");
    expect(worldPage).not.toContain('class="pw-toast"');
    expect(worldStyles).toContain(".pw-header-signal__board::before");
    expect(worldStyles).toContain("@keyframes pw-destination-board-roll");
    expect(worldStyles).toContain("animation: pw-destination-board-roll");
    expect(worldStyles).toContain("height: 2.35rem");
    expect(worldStyles).toContain("align-self: end");
    expect(worldStyles).not.toContain("pw-header-marquee");
    expect(worldStyles).not.toContain(".pw-toast");
  });

  test("uses a game-board beacon in the header and keeps mobile panes vertical", () => {
    const worldPage = source(
      "src/client/components/persistent-world/PersistentWorldPage.ts",
    );
    const worldStyles = source("src/client/styles/persistent-world.css");

    expect(worldPage).toContain('<circle cx="12" cy="12" r="6.25">');
    expect(worldPage).toContain(
      '<path d="M12 2.75v3M12 18.25v3M2.75 12h3M18.25 12h3">',
    );
    expect(worldPage).not.toContain('<circle cx="8.25" cy="14.25"');
    expect(worldPage).not.toContain("M7.25 4.75h9.5");
    expect(worldStyles).toContain(".pw-intentional-scroll {");
    expect(worldStyles).toContain("overflow-x: hidden;");
    expect(worldStyles).toContain("overflow-y: auto;");
    expect(worldStyles).toContain("touch-action: pan-y pinch-zoom;");
    expect(worldStyles).not.toContain("overflow: auto;");
  });

  test("keeps lobby rosters fresh across devices and mobile foregrounding", () => {
    const worldPage = source(
      "src/client/components/persistent-world/PersistentWorldPage.ts",
    );

    expect(worldPage).toContain("LOBBY_POLL_INTERVAL_MS = 3_000");
    expect(worldPage).toContain(
      'document.addEventListener("visibilitychange", this.handleVisibilityChange)',
    );
    expect(worldPage).toContain(
      'window.addEventListener("focus", this.refreshVisibleLobby)',
    );
    expect(worldPage).toContain("quiet || this.snapshot !== null");
    expect(worldPage).toContain("clearTimeout(this.pollTimer)");
    expect(worldPage).not.toContain("setInterval(");
  });

  test("turns an active member's countdown into the world entry control", () => {
    const main = source("src/client/Main.ts");
    const worldPage = source(
      "src/client/components/persistent-world/PersistentWorldPage.ts",
    );
    const worldComponents = source(
      "src/client/components/persistent-world/PersistentWorldComponents.ts",
    );

    expect(worldComponents).toContain(
      'world.phase === "active" && snapshot.viewer.isMember',
    );
    expect(worldComponents).toContain('class="pw-countdown pw-entry-control"');
    expect(worldComponents).toContain("?disabled=${!snapshot.runtimeGameId}");
    expect(worldComponents).toContain('"Preparing map…"');
    expect(worldComponents).toContain('? "Play world"');
    expect(worldComponents).toContain('? "Return to world"');
    expect(worldComponents).toContain('new CustomEvent("world-enter-runtime"');
    expect(worldPage).toContain(
      "@world-enter-runtime=${this.enterRuntimeFromCard}",
    );
    expect(worldPage).toContain('source: "persistent-world"');
    expect(main).toContain('lobby.source !== "persistent-world"');
    expect(worldPage).toContain("placeholderCopy.worlds.pendingDescription");
  });

  test("returns wizard cancellation to the worlds menu without a stale route", () => {
    const worldPage = source(
      "src/client/components/persistent-world/PersistentWorldPage.ts",
    );

    expect(worldPage).toContain("@world-wizard-close=${this.returnFromWizard}");
    expect(worldPage).toContain(
      'history.replaceState(history.state, "", "/worlds")',
    );
    expect(worldPage).not.toContain("history.back()");
    expect(worldPage).not.toContain(
      "@world-wizard-close=${() => this.showHub(false)}",
    );
  });

  test("bridges semantic haptics to Expo and reserves signatures for alerts and nukes", () => {
    const haptics = source("src/client/ui/Haptics.ts");
    const nativeSurface = source("apps/mobile/src/GameSurface.tsx");
    const buildMenu = source("src/client/hud/layers/BuildMenu.ts");
    const alertFrame = source("src/client/hud/layers/AlertFrame.ts");

    expect(haptics).toContain('type: "idlefront:haptic"');
    expect(haptics).toContain("export class UiHapticController");
    expect(nativeSurface).toContain("onMessage={handleBridgeMessage}");
    expect(nativeSurface).toContain("Haptics.ImpactFeedbackStyle.Rigid");
    expect(nativeSurface).toContain("Haptics.NotificationFeedbackType.Warning");
    expect(buildMenu).toContain('nuclearAction ? "nuke" : "selection"');
    expect(alertFrame).toContain('requestHaptic("alert")');
  });
});
