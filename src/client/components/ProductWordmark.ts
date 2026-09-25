import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { placeholderCopy } from "../copy/PlaceholderCopy";

/**
 * IdleFront's code-native product mark.
 *
 * The component deliberately renders into the light DOM so the shared product
 * skin can size and colour it wherever it is placed (desktop navigation,
 * mobile navigation, or an in-game information rail).
 *
 * Usage:
 *   <product-wordmark></product-wordmark>
 *   <product-wordmark compact></product-wordmark>
 *   <product-wordmark compact quiet></product-wordmark>
 */
@customElement("product-wordmark")
export class ProductWordmark extends LitElement {
  @property({ type: Boolean, reflect: true })
  compact = false;

  @property({ type: Boolean, reflect: true })
  quiet = false;

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <span class="atlas-wordmark" role="img" aria-label="IdleFront">
        <span class="atlas-wordmark__mark" aria-hidden="true">
          <svg
            class="atlas-wordmark__glyph"
            viewBox="0 0 48 48"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            focusable="false"
          >
            <circle class="atlas-wordmark__orbit" cx="24" cy="24" r="18.5" />
            <path
              class="atlas-wordmark__latitude"
              d="M7.2 24h33.6M10.2 15.3c4.1 2.2 8.8 3.3 13.8 3.3 5 0 9.7-1.1 13.8-3.3M10.2 32.7c4.1-2.2 8.8-3.3 13.8-3.3 5 0 9.7 1.1 13.8 3.3M24 5.5c-4.2 5.2-6.3 11.4-6.3 18.5S19.8 37.3 24 42.5M24 5.5c4.2 5.2 6.3 11.4 6.3 18.5S28.2 37.3 24 42.5"
            />
            <path
              class="atlas-wordmark__needle"
              d="m28.1 19.9-2.2 6-6 2.2 2.2-6 6-2.2Z"
            />
            <circle class="atlas-wordmark__pin" cx="24" cy="24" r="1.55" />
            <path
              class="atlas-wordmark__bearing"
              d="M24 1.75v3M24 43.25v3M1.75 24h3M43.25 24h3"
            />
          </svg>
        </span>
        <span class="atlas-wordmark__type">
          <span class="atlas-wordmark__name">
            <span>Idle</span><span>Front</span>
          </span>
          <span
            class="atlas-wordmark__descriptor"
            aria-hidden="true"
            data-copy-slot="landing.subtitle"
            >${placeholderCopy.landing.subtitle}</span
          >
        </span>
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "product-wordmark": ProductWordmark;
  }
}
