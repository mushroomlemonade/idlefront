import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { assetUrl } from "../../core/AssetUrls";
import "../styles/ratio-slider.css";

/** A target handle over a read-only composition bar; dragging never changes the bar's meaning. */
@customElement("population-ratio-slider")
export class PopulationRatioSlider extends LitElement {
  @property({ type: Number }) value = 50;
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 100;
  @property() suffix = "%";
  @property() readout = "";
  @property({ type: Boolean }) snapInteger = false;
  @state() private sliding = false;
  private activePointer: number | null = null;
  private pointerRange = { min: 0, max: 100 };
  private emitValue() {
    this.dispatchEvent(
      new CustomEvent("attack-ratio-input", {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      }),
    );
  }
  private movePointer = (event: PointerEvent) => {
    if (this.activePointer !== event.pointerId) return;
    event.stopPropagation();
    const track = (
      event.currentTarget as HTMLElement
    ).parentElement!.getBoundingClientRect();
    if (track.width <= 0) return;
    const fraction = Math.max(
      0,
      Math.min(
        1,
        (event.clientX - track.left - 12) / Math.max(1, track.width - 24),
      ),
    );
    this.value =
      this.pointerRange.min +
      fraction * (this.pointerRange.max - this.pointerRange.min);
    this.emitValue();
  };
  private startPointer = (event: PointerEvent) => {
    event.stopPropagation();
    if (!this.snapInteger) {
      this.sliding = true;
      return;
    }
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    this.activePointer = event.pointerId;
    this.pointerRange = { min: this.min, max: this.max };
    this.sliding = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.movePointer(event);
  };
  private endPointer = (event: PointerEvent) => {
    if (this.activePointer !== event.pointerId) return;
    event.preventDefault();
    this.movePointer(event);
    this.activePointer = null;
    this.sliding = false;
    this.value = Math.round(this.value);
    this.emitValue();
    this.dispatchEvent(new Event("change", { bubbles: true }));
  };
  @property({ type: Number }) available = 0;
  @property({ type: Number }) committed = 0;
  @property() label = "";
  @property() description = "";
  @property() barValue = "";
  @property() barEndValue = "";
  @state() private valueOnRight = false;
  protected willUpdate() {
    // A small dead band prevents rapid side swapping while dragging at the cutoff.
    const percentage = (this.value / this.max) * 100;
    if (percentage < 15) this.valueOnRight = true;
    else if (percentage >= 20) this.valueOnRight = false;
  }
  createRenderRoot() {
    return this;
  }
  render() {
    const available = Math.max(0, Math.min(100, this.available));
    const committed = Math.max(0, Math.min(100 - available, this.committed));
    return html` <div class="atlas-ratio-heading">
        <span>${this.label}</span
        ><output
          >${this.readout || `${Math.round(this.value)}${this.suffix}`}</output
        >
      </div>
      <div
        class="atlas-ratio-track ${this.snapInteger ? "is-snapping" : ""} ${this.sliding ? "is-sliding" : ""}"
        style=${`--atlas-slider-pointer:url("${assetUrl("images/SliderPointer.svg")}");--handle-position:${((this.value - this.min) / (this.max - this.min || 1)) * 100}%;--handle-inset:${((this.value - this.min) / (this.max - this.min || 1)) * 24}px`}
      >
        <div class="atlas-troop-meter" aria-hidden="true">
          <span style="width:${available}%;background:#416789"></span>
          <span style="width:${committed}%;background:#977044"></span>
        </div>
        ${this.barEndValue ? html`<span class="atlas-ratio-bar-value is-paired ${this.value / this.max < 0.35 ? "avoid-left" : this.value / this.max > 0.65 ? "avoid-right" : ""}"><span>${this.barValue}</span><span>${this.barEndValue}</span></span>` : this.barValue ? html`<span class="atlas-ratio-bar-value ${this.valueOnRight ? "is-right" : ""}"><span>${this.barValue}</span></span>` : ""}
        ${this.snapInteger ? html`<span class="atlas-ratio-visual-pointer" aria-hidden="true"></span>` : ""}
        <input
          type="range"
          min=${this.min}
          max=${this.max}
          step=${this.snapInteger ? "any" : "1"}
          .value=${String(this.value)}
          aria-label=${this.label}
          aria-valuetext=${`${this.value}${this.suffix}; ${this.description}`}
          @pointerdown=${this.startPointer}
          @pointermove=${this.movePointer}
          @pointerup=${this.endPointer}
          @lostpointercapture=${() => {
            this.activePointer = null;
            this.sliding = false;
          }}
          @pointercancel=${() => {
            this.activePointer = null;
            this.sliding = false;
          }}
          @change=${() => {
            this.sliding = false;
            if (this.snapInteger) {
              this.value = Math.round(this.value);
              this.dispatchEvent(
                new CustomEvent("attack-ratio-input", {
                  detail: { value: this.value },
                  bubbles: true,
                  composed: true,
                }),
              );
            }
          }}
          @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
          @input=${(e: Event) => {
            e.stopPropagation();
            this.value = Number((e.target as HTMLInputElement).value);
            this.dispatchEvent(
              new CustomEvent("attack-ratio-input", {
                detail: { value: this.value },
                bubbles: true,
                composed: true,
              }),
            );
          }}
        />
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "population-ratio-slider": PopulationRatioSlider;
  }
}
