import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";

export type AtlasMaterial =
  "chrome" | "mahogany" | "felt" | "brass" | "parchment" | "glass";

export type AtlasElevation = "inset" | "flush" | "raised" | "floating";

@customElement("atlas-surface")
export class AtlasSurface extends LitElement {
  static get observedAttributes() {
    return ["material", "elevation"];
  }

  private surface: HTMLDivElement | null = null;

  get material(): AtlasMaterial {
    return (
      (this.getAttribute("material") as AtlasMaterial | null) ?? "mahogany"
    );
  }

  set material(value: AtlasMaterial) {
    this.setAttribute("material", value);
  }

  get elevation(): AtlasElevation {
    return (
      (this.getAttribute("elevation") as AtlasElevation | null) ?? "raised"
    );
  }

  set elevation(value: AtlasElevation) {
    this.setAttribute("elevation", value);
  }

  get interactive(): boolean {
    return this.hasAttribute("interactive");
  }

  set interactive(value: boolean) {
    this.toggleAttribute("interactive", value);
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // Lit finishes placing the declarative children before this microtask. The
    // wrapper then owns those same live nodes, avoiding light-DOM <slot>
    // duplication while keeping the global material stylesheet reusable.
    queueMicrotask(() => {
      if (!this.isConnected) return;
      this.ensureSurface();
    });
  }

  attributeChangedCallback(
    _name: string,
    _oldValue: string | null,
    _newValue: string | null,
  ): void {
    this.syncSurfaceClasses();
  }

  private ensureSurface(): void {
    const existing = this.querySelector<HTMLDivElement>(
      ":scope > [data-atlas-surface-root]",
    );
    if (existing) {
      this.surface = existing;
      this.syncSurfaceClasses();
      return;
    }

    const surface = document.createElement("div");
    surface.dataset.atlasSurfaceRoot = "";
    while (this.firstChild) surface.append(this.firstChild);
    this.append(surface);
    this.surface = surface;
    this.syncSurfaceClasses();
  }

  private syncSurfaceClasses(): void {
    if (!this.surface) return;
    this.surface.className = `atlas-material-surface atlas-material-${this.material} atlas-elevation-${this.elevation}`;
  }
}

@customElement("atlas-gauge")
export class AtlasGauge extends LitElement {
  @property() label = "";
  @property() value = "";
  @property({ type: Number }) progress = 0;
  @property() tone: "brass" | "green" | "danger" = "brass";

  createRenderRoot() {
    return this;
  }

  render() {
    const clamped = Math.max(0, Math.min(1, this.progress));
    return html`<div
      class="atlas-gauge atlas-gauge--${this.tone}"
      style=${`--atlas-gauge-progress:${clamped * 270}deg`}
      role="meter"
      aria-label=${this.label || nothing}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${Math.round(clamped * 100)}
    >
      <span class="atlas-gauge__dial" aria-hidden="true"></span>
      <strong>${this.value}</strong>
      <span>${this.label}</span>
    </div>`;
  }
}

@customElement("atlas-status-lamp")
export class AtlasStatusLamp extends LitElement {
  @property() label = "";
  @property({ attribute: "i18n-key" }) i18nKey = "";

  createRenderRoot() {
    return this;
  }

  render() {
    const translatedLabel =
      this.i18nKey === "pressure_atlas.world_online"
        ? translateText("pressure_atlas.world_online")
        : this.label;
    return html`<span class="atlas-status-lamp" role="status">
      <span class="atlas-status-lamp__light" aria-hidden="true"></span>
      <span data-i18n=${this.i18nKey || nothing}>${translatedLabel}</span>
    </span>`;
  }
}

@customElement("atlas-nav-item")
export class AtlasNavItem extends LitElement {
  @property() page = "";
  @property({ attribute: "i18n-key" }) i18nKey = "";
  @property() label = "";
  @property({ type: Boolean, reflect: true }) active = false;
  @property({ type: Boolean, reflect: true }) compact = false;
  @property() attention: "none" | "info" | "danger" = "none";

  createRenderRoot() {
    return this;
  }

  render() {
    return html`<button
      type="button"
      class="atlas-nav-item nav-menu-item ${this.active ? "active" : ""}"
      data-page=${this.page || nothing}
      data-i18n=${this.i18nKey || nothing}
    >
      ${this.label}
      ${
        this.attention === "none"
          ? nothing
          : html`<span
              class="atlas-nav-item__attention atlas-nav-item__attention--${
                this.attention
              }"
              aria-hidden="true"
            ></span>`
      }
    </button>`;
  }
}
