import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";

/** Global account, consent, and enforcement surfaces shared by every page. */
@customElement("atlas-global-overlays")
export class AtlasGlobalOverlays extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <banned-modal></banned-modal>
      <marketing-consent-toast></marketing-consent-toast>
      <steam-link-modal></steam-link-modal>
    `;
  }
}
