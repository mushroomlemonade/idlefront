import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { correspondingSourceUrl } from "../SourceLinks";

@customElement("page-footer")
export class Footer extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <footer class="atlas-footer [.in-game_&]:hidden">
        <div class="atlas-footer__status">
          <span class="atlas-live-dot" aria-hidden="true"></span>
          <span data-i18n="pressure_atlas.footer_status"
            >Development world online</span
          >
          <span aria-hidden="true">·</span>
          <span data-i18n="pressure_atlas.footer_build"
            >IdleFront working build</span
          >
        </div>

        <nav
          class="atlas-footer__links"
          aria-label="Project links"
          data-i18n-aria-label="pressure_atlas.footer_links_label"
        >
          <button class="nav-menu-item" data-page="page-legal">
            Legal &amp; source
          </button>
          <a
            href=${correspondingSourceUrl()}
            target="_blank"
            rel="noopener noreferrer"
            data-i18n="main.github"
            >GitHub</a
          >
        </nav>

        <lang-selector class="atlas-footer__language"></lang-selector>

        <p class="atlas-footer__credit">
          <span data-i18n="main.copyright">© OpenFront and Contributors</span>
          <span aria-hidden="true"> · </span>
          <span data-i18n="pressure_atlas.footer_credit"
            >Engine licensed under AGPL-3.0 · Open map assets CC BY-SA</span
          >
        </p>
      </footer>
    `;
  }
}
