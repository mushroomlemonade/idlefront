import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { UserSettings } from "../../core/game/UserSettings";

@customElement("frame-rate-setting")
export class FrameRateSetting extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    const settings = new UserSettings();
    return html`<label
      style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;color:var(--atlas-hud-text,#eee)"
    >
      <span
        >frame rate<small style="display:block;font-weight:400;opacity:.75"
          >maximum fps · limited by your display and browser</small
        ></span
      >
      <select
        aria-label="frame rate"
        style="background:#17231f;color:#eee;border:1px solid #827653;border-radius:6px;padding:8px"
        @change=${(event: Event) => {
          settings.setFrameRateLimit(
            Number((event.target as HTMLSelectElement).value),
          );
          this.requestUpdate();
        }}
      >
        ${[30, 60, 90, 120, 144, 165, 240].map((fps) => html`<option value=${fps} ?selected=${settings.frameRateLimit() === fps}>${fps} fps</option>`)}
      </select>
    </label>`;
  }
}
