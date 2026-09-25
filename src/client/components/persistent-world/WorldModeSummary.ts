import { html, nothing } from "lit";
import { WORLD_PRESETS, type WorldPreset } from "../../../core/WorldPresets";

/** Text remains available to touch and assistive technology; icons are not a legend to memorize. */
export function worldModeSummary(id?: WorldPreset) {
  if (!id) return nothing;
  const preset = WORLD_PRESETS[id];
  if ("duration" in preset) {
    const duration = { "1h": "1 hour", "1d": "1 day", "7d": "1 week" }[
      preset.duration
    ];
    return html`<span class="pw-mode-summary" aria-label=${preset.label}>
      <span>Earth · ${preset.scale}×</span><span>Target: ${duration}</span>
    </span>`;
  }
  const items = [
    {
      label: "Trade ships",
      value: `×${preset.trade}`,
      path: "M3 13h18l-3 6H6zM7 13V7h9v6M10 7V4M2 22l3-1 4 1 3-1 4 1 3-1 3 1",
    },
    {
      label: "Trains",
      value: `×${preset.trains}`,
      path: "M7 3h10v14H7zM7 10h10M10 3v7M14 3v7M9 17l-3 5M15 17l3 5M8 20h8M9 14h1M14 14h1",
    },
    {
      label: "Attack speed",
      value: preset.attackDivisor === 1 ? "×1" : `÷${preset.attackDivisor}`,
      path: "M5 19L19 5M13 4h7v7M4 14l6 6M3 21l3-3",
    },
  ];
  return html`<span class="pw-mode-summary" aria-label=${preset.label}>
    ${items.map(
      (item) =>
        html`<span
          class="pw-mode-summary__stat"
          aria-label=${item.label + " " + item.value}
          title=${item.label + " " + item.value}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d=${item.path}></path>
          </svg>
          <span>${item.value}</span
          ><span class="pw-mode-summary__label">${item.label}</span>
        </span>`,
    )}
  </span>`;
}
