import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { DebugPlaytestPreset } from "../../core/DebugPlaytest";
import { runtimeDebugEnabled } from "../RuntimeDebug";
import { requestHaptic } from "../ui/Haptics";

const REQUIRED_LOGO_TAPS = 7;
const TAP_SEQUENCE_TIMEOUT_MS = 4_000;

let logoTapCount = 0;
let lastLogoTapAt = 0;

export interface DeveloperMenuOrigin {
  x: number;
  y: number;
}

export function resetDeveloperMenuTapSequence(): void {
  logoTapCount = 0;
  lastLogoTapAt = 0;
}

/** Records one logo activation and opens the singleton menu on tap seven. */
export function recordDeveloperMenuLogoTap(
  now: number = performance.now(),
  origin?: DeveloperMenuOrigin,
): boolean {
  if (now - lastLogoTapAt > TAP_SEQUENCE_TIMEOUT_MS) logoTapCount = 0;
  lastLogoTapAt = now;
  logoTapCount++;
  if (logoTapCount < REQUIRED_LOGO_TAPS) return false;

  resetDeveloperMenuTapSequence();
  requestHaptic("success");
  openDeveloperMenu(origin);
  return true;
}

export function openDeveloperMenu(
  origin?: DeveloperMenuOrigin,
): IdleFrontDeveloperMenu {
  const existing = document.querySelector<IdleFrontDeveloperMenu>(
    "idlefront-developer-menu",
  );
  if (existing) return existing;
  const menu = document.createElement("idlefront-developer-menu");
  if (origin) {
    menu.style.setProperty("--atlas-dev-origin-x", `${origin.x}px`);
    menu.style.setProperty("--atlas-dev-origin-y", `${origin.y}px`);
  }
  document.body.append(menu);
  return menu;
}

@customElement("idlefront-developer-menu")
export class IdleFrontDeveloperMenu extends LitElement {
  @state() private copyState: "idle" | "copied" | "failed" = "idle";
  @state() private gameAction: DebugPlaytestPreset | null = null;
  @state() private gameStatus = "";
  private previouslyFocused: HTMLElement | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    document.body.classList.add("atlas-dev-menu-open");
    window.addEventListener("keydown", this.onKeyDown);
    this.updateComplete.then(() =>
      this.querySelector<HTMLElement>("button")?.focus(),
    );
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    document.body.classList.remove("atlas-dev-menu-open");
    this.previouslyFocused?.focus();
    super.disconnectedCallback();
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.close();
  };

  private close = (): void => {
    this.remove();
  };

  private onBackdropClick = (event: MouseEvent): void => {
    if (event.target === event.currentTarget) this.close();
  };

  private diagnostics(): string {
    const detectedVersion = document
      .querySelector("#game-version, .game-version-display")
      ?.textContent?.trim();
    const version = detectedVersion?.length ? detectedVersion : "development";
    return [
      `IdleFront ${version}`,
      `URL: ${location.href}`,
      `Shell: ${window.ReactNativeWebView ? "native WebView" : "browser"}`,
      `Viewport: ${window.innerWidth}x${window.innerHeight}`,
      `Pixel ratio: ${window.devicePixelRatio}`,
      `UI fidelity: ${document.body.dataset.uiFidelity ?? "unknown"}`,
      `Online: ${navigator.onLine ? "yes" : "no"}`,
      `User agent: ${navigator.userAgent}`,
    ].join("\n");
  }

  private copyDiagnostics = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(this.diagnostics());
      this.copyState = "copied";
      requestHaptic("success");
    } catch {
      this.copyState = "failed";
      requestHaptic("error");
    }
  };

  private reload = (): void => {
    location.reload();
  };

  private quickJoin = async (preset: DebugPlaytestPreset): Promise<void> => {
    this.close();
    window.location.assign(
      "/worlds/new?kind=custom&preset=" + encodeURIComponent(preset),
    );
  };

  render() {
    return html`
      <div
        class="atlas-dev-menu__backdrop"
        role="presentation"
        @click=${this.onBackdropClick}
      >
        <section
          class="atlas-dev-menu"
          role="dialog"
          aria-modal="true"
          aria-labelledby="atlas-dev-menu-title"
        >
          <header class="atlas-dev-menu__header">
            <div>
              <span>Development tools</span>
              <h2 id="atlas-dev-menu-title">Field laboratory</h2>
            </div>
            <button
              class="atlas-dev-menu__close"
              type="button"
              aria-label="Close developer menu"
              data-haptic="light"
              @click=${this.close}
            >
              ×
            </button>
          </header>

          <div class="atlas-dev-menu__status" aria-label="Preview status">
            <i aria-hidden="true"></i>
            <span
              >${window.ReactNativeWebView ? "Native shell" : "Web preview"}</span
            >
            <strong>${window.innerWidth} × ${window.innerHeight}</strong>
          </div>

          <nav
            class="atlas-dev-menu__links"
            aria-label="Developer destinations"
          >
            <a class="atlas-war-button" href="/?ui-lab=1">
              <span
                ><strong>Material UI lab</strong
                ><small>Surfaces and instruments</small></span
              >
              <b aria-hidden="true">›</b>
            </a>
            <a
              class="atlas-war-button atlas-war-button--secondary"
              href="/?ui-lab=stone-buttons"
            >
              <span
                ><strong>Stone controls</strong
                ><small>Button materials and states</small></span
              >
              <b aria-hidden="true">›</b>
            </a>
            <a
              class="atlas-war-button atlas-war-button--secondary"
              href="/?ui-lab=hud"
            >
              <span
                ><strong>HUD reference</strong
                ><small>Review the in-game UI</small></span
              >
              <b aria-hidden="true">›</b>
            </a>
            <a
              class="atlas-war-button atlas-war-button--secondary"
              href="/worlds"
            >
              <span
                ><strong>World hub</strong
                ><small>Invitation and lobby flow</small></span
              >
              <b aria-hidden="true">›</b>
            </a>
            <a
              class="atlas-war-button atlas-war-button--secondary"
              href="/worlds/new"
            >
              <span
                ><strong>World wizard</strong><small>Creation flow</small></span
              >
              <b aria-hidden="true">›</b>
            </a>
          </nav>

          <div class="atlas-dev-menu__actions">
            ${
              runtimeDebugEnabled()
                ? html`
                    <button
                      class="atlas-war-button"
                      type="button"
                      ?disabled=${this.gameAction !== null}
                      @click=${() => this.quickJoin("great-lakes")}
                    >
                      <span
                        ><strong>Great Lakes</strong
                        ><small>Join or create the lake test</small></span
                      >
                    </button>
                    <button
                      class="atlas-war-button atlas-war-button--secondary"
                      type="button"
                      ?disabled=${this.gameAction !== null}
                      @click=${() => this.quickJoin("enormous-earth")}
                    >
                      <span
                        ><strong>Enormous Earth</strong
                        ><small
                          >Join or create the Ultra-scale test</small
                        ></span
                      >
                    </button>
                    ${
                      this.gameStatus
                        ? html`<p role="status">${this.gameStatus}</p>`
                        : null
                    }
                  `
                : null
            }
            <button
              class="atlas-war-button atlas-war-button--secondary"
              type="button"
              data-haptic="none"
              @click=${this.copyDiagnostics}
            >
              <span
                >${
                  this.copyState === "copied"
                    ? "Diagnostics copied"
                    : this.copyState === "failed"
                      ? "Copy unavailable"
                      : "Copy diagnostics"
                }</span
              >
            </button>
            <button
              class="atlas-war-button atlas-war-button--secondary"
              type="button"
              @click=${this.reload}
            >
              <span>Reload current view</span>
            </button>
          </div>

          <footer>
            <code>7× logo</code>
            <span>Private preview utility</span>
          </footer>
        </section>
      </div>
      <div class="atlas-dev-menu__unlock-flare" aria-hidden="true"></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "idlefront-developer-menu": IdleFrontDeveloperMenu;
  }
}
