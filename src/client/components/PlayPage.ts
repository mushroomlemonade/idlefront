import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { placeholderCopy } from "../copy/PlaceholderCopy";
import { correspondingSourceUrl } from "../SourceLinks";
import "./ProductWordmark";

@customElement("play-page")
export class PlayPage extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div id="page-play" class="atlas-play-page">
        <token-login class="absolute"></token-login>
        <rewards-modal class="absolute"></rewards-modal>

        <div class="atlas-title-stage">
          <section class="atlas-launch-console" aria-label="IdleFront">
            <h1 class="sr-only">IdleFront</h1>
            <div class="atlas-app-identity" aria-hidden="true">
              <product-wordmark></product-wordmark>
            </div>

            <div class="atlas-identity-card">
              <span
                class="atlas-identity-card__label"
                data-copy-slot="landing.identityLabel"
                >${placeholderCopy.landing.identityLabel}</span
              >
              <username-input class="atlas-username-input"></username-input>
            </div>

            <game-mode-selector></game-mode-selector>

            <footer
              class="atlas-compliance-rail"
              aria-label="Attribution and source"
            >
              <span aria-label="version"
                >${import.meta.env.DEV ? "v26.4 · dev" : "v26.4"}</span
              >
              <span>© OpenFront and Contributors</span>
              <span class="atlas-compliance-rail__disclosure"
                >Independent modification</span
              >
              <nav aria-label="Legal links">
                <a
                  href=${correspondingSourceUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  >Source</a
                >
                <button
                  type="button"
                  class="nav-menu-item"
                  data-page="page-legal"
                  data-haptic="light"
                >
                  Legal
                </button>
              </nav>
            </footer>
          </section>
        </div>
      </div>
    `;
  }
}
