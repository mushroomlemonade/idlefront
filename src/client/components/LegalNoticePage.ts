import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { correspondingSourceUrl, sourceFileUrl } from "../SourceLinks";
import "./ProductWordmark";

@customElement("legal-notice-page")
export class LegalNoticePage extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <section class="atlas-legal-page" aria-labelledby="legal-notice-title">
        <header class="atlas-legal-page__header">
          <product-wordmark compact quiet></product-wordmark>
          <div>
            <p>Independent modified version</p>
            <h1 id="legal-notice-title">Legal &amp; source</h1>
          </div>
        </header>

        <div class="atlas-legal-page__notice">
          <strong>© OpenFront and Contributors</strong>
          <span>Modified by IdleFront contributors, 2026</span>
        </div>

        <p class="atlas-legal-page__summary">
          IdleFront is an independent modification of OpenFront. It is not
          affiliated with, endorsed by, or an official product of OpenFront Inc.
        </p>

        <div class="atlas-legal-page__grid">
          <article>
            <h2>Free software</h2>
            <p>
              The program is licensed under GNU AGPL version 3. You may copy,
              convey, and modify it under that license. It is provided without
              warranty.
            </p>
          </article>
          <article>
            <h2>Licensed assets</h2>
            <p>
              Assets are governed individually by LICENSE-ASSETS and the
              attribution details in the project credits. Assets identified
              there as proprietary are not relicensed by this fork.
            </p>
          </article>
        </div>

        <nav class="atlas-legal-page__links" aria-label="Legal documents">
          <a
            href=${correspondingSourceUrl()}
            target="_blank"
            rel="noopener noreferrer"
            >Complete source</a
          >
          <a
            href=${sourceFileUrl("LICENSE")}
            target="_blank"
            rel="noopener noreferrer"
            >AGPL license</a
          >
          <a
            href=${sourceFileUrl("LICENSE-ASSETS")}
            target="_blank"
            rel="noopener noreferrer"
            >Asset license</a
          >
          <a
            href=${sourceFileUrl("CREDITS.md")}
            target="_blank"
            rel="noopener noreferrer"
            >Credits</a
          >
        </nav>

        <button
          type="button"
          class="atlas-legal-page__return nav-menu-item"
          data-page="page-play"
        >
          Return to IdleFront
        </button>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "legal-notice-page": LegalNoticePage;
  }
}
