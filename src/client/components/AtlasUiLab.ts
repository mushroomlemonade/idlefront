import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import "../styles/stone-button-specimen.css";
import "./AtlasPrimitives";
import "./AttackRatioDial";

const STONE_BUTTON_LAB = "stone-buttons";

const stonePalette = [
  {
    variant: "quartz",
    label: "Quartz",
  },
  {
    variant: "obsidian",
    label: "Obsidian",
  },
  {
    variant: "amethyst",
    label: "Amethyst",
  },
  {
    variant: "ruby",
    label: "Ruby",
  },
  {
    variant: "emerald",
    label: "Emerald",
  },
] as const;

@customElement("atlas-ui-lab")
export class AtlasUiLab extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    if (
      new URLSearchParams(location.search).get("ui-lab") === STONE_BUTTON_LAB
    ) {
      return this.renderStoneButtonLab();
    }

    return html`
      <main class="atlas-ui-lab" aria-label="IdleFront UI material lab">
        <header class="atlas-ui-lab__header">
          <div class="atlas-ui-lab__eyebrow">
            <p>IdleFront · Material Laboratory</p>
            <a
              class="atlas-ui-lab__specimen-link"
              href="?ui-lab=${STONE_BUTTON_LAB}"
            >
              Stone controls <span aria-hidden="true">›</span>
            </a>
          </div>
          <h1>Executive war-room component system</h1>
          <span>Development-only deterministic reference surface</span>
        </header>

        <div class="atlas-ui-lab__workspace">
          <section class="atlas-ui-lab__grid" aria-label="Material surfaces">
            ${(
              [
                "mahogany",
                "felt",
                "parchment",
                "brass",
                "chrome",
                "glass",
              ] as const
            ).map(
              (material) => html`
                <atlas-surface material=${material} elevation="raised">
                  <div class="atlas-ui-lab__sample">
                    <small>${material}</small>
                    <strong>Material specimen</strong>
                    <span>Retina texture · polished edge · semantic depth</span>
                  </div>
                </atlas-surface>
              `,
            )}
          </section>

          <section class="atlas-ui-lab__controls" aria-label="Control states">
            <button class="atlas-war-button atlas-war-button--primary">
              Confirm order
            </button>
            <button class="atlas-war-button atlas-war-button--secondary">
              Review front
            </button>
            <button class="atlas-war-button atlas-war-button--danger">
              Break alliance
            </button>
            <button class="atlas-war-button" disabled>Unavailable</button>
            <attack-ratio-dial
              class="atlas-attack-dial--mobile"
              value="42"
              step="10"
              label="Attack ratio"
              display-value="128K"
            ></attack-ratio-dial>
            <label class="atlas-war-field">
              <span>Operation name</span>
              <input value="Northern Watch" />
            </label>
            <label class="atlas-war-field">
              <span>Commitment</span>
              <input type="range" min="1" max="100" value="42" />
            </label>
          </section>

          <section class="atlas-ui-lab__gauges" aria-label="Instrument states">
            <atlas-gauge
              label="Reserve"
              value="42%"
              progress="0.42"
            ></atlas-gauge>
            <atlas-gauge
              label="Treasury"
              value="8.4M"
              progress="0.73"
              tone="green"
            ></atlas-gauge>
            <atlas-gauge
              label="Pressure"
              value="HIGH"
              progress="0.91"
              tone="danger"
            ></atlas-gauge>
          </section>
        </div>
      </main>
    `;
  }

  private renderStoneButtonLab() {
    return html`
      <main
        class="atlas-stone-lab"
        aria-label="IdleFront stone button laboratory"
      >
        <header class="atlas-stone-lab__header">
          <a class="atlas-stone-lab__back" href="?ui-lab=1">
            <span aria-hidden="true">‹</span>
            Materials
          </a>
          <div class="atlas-stone-lab__title">
            <p>IdleFront · Control specimen</p>
            <h1>Old controls, new stone texture</h1>
          </div>
          <p class="atlas-stone-lab__instruction">
            Press and hold any face. The original motion is unchanged.
          </p>
        </header>

        <section
          class="atlas-stone-lab__workspace atlas-texture-demo"
          aria-labelledby="stone-texture-title"
        >
          <div class="atlas-texture-demo__heading">
            <span>Texture pass 01</span>
            <h2 id="stone-texture-title">The same button underneath</h2>
          </div>

          <div class="atlas-texture-demo__grid">
            <button
              class="atlas-war-button atlas-texture-demo__button"
              type="button"
            >
              <span>Original control</span>
            </button>

            ${stonePalette.map(
              ({ variant, label }) => html`
                <button
                  class="atlas-war-button atlas-texture-demo__button"
                  data-stone=${variant}
                  type="button"
                >
                  <span>${label} texture</span>
                </button>
              `,
            )}
          </div>

          <p class="atlas-texture-demo__note">
            Native button · existing press · photographic texture layer only
          </p>
        </section>

        <footer class="atlas-stone-lab__footer">
          <code>.atlas-war-button</code>
          <span>Quartz · Obsidian · Amethyst · Ruby · Emerald</span>
        </footer>
      </main>
    `;
  }
}

export function mountAtlasUiLab(): boolean {
  const lab = new URLSearchParams(location.search).get("ui-lab");
  if (lab === "recovery") {
    document.body.classList.add("atlas-ui-lab-active", "in-game");
    void customElements.whenDefined("simulation-recovery-overlay").then(() => {
      if (!document.querySelector(":scope > simulation-recovery-overlay")) {
        document.body.append(
          document.createElement("simulation-recovery-overlay"),
        );
      }
      window.dispatchEvent(
        new CustomEvent("idlefront:simulation-recovery", {
          detail: {
            type: "simulation_recovery",
            status: "replaying",
            completedTurns: 10_944,
            totalTurns: 23_287,
            elapsedMs: 398_000,
          },
        }),
      );
    });
    return true;
  }
  if (lab === "hud") {
    void import("./AtlasHudReference").then(({ mountHudReference }) =>
      mountHudReference(),
    );
    return true;
  }
  if (lab !== "1" && lab !== STONE_BUTTON_LAB) return false;
  document.body.classList.add("atlas-ui-lab-active");
  document.body.classList.toggle("in-game", lab === "1");
  document.body.classList.toggle(
    "atlas-ui-lab-stone-active",
    lab === STONE_BUTTON_LAB,
  );
  document.body.append(document.createElement("atlas-ui-lab"));
  return true;
}
