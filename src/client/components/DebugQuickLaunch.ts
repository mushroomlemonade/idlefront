import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { DebugPlaytestPreset } from "../../core/DebugPlaytest";
import { quickJoinDebugGame } from "../DebugQuickStart";
import { requestHaptic } from "../ui/Haptics";

@customElement("idlefront-debug-quick-launch")
export class DebugQuickLaunch extends LitElement {
  @state() private expanded = false;
  @state() private longSession = false;
  @state() private action: DebugPlaytestPreset | null = null;
  @state() private status = "Debug tools";

  static styles = css`
    :host {
      display: block;
      min-width: 0;
      width: 100%;
      margin-bottom: 12px;
      color: #f6f1df;
      font:
        600 12px/1.25 system-ui,
        sans-serif;
    }
    label {
      grid-column: 1 / -1;
      display: flex;
      gap: 8px;
      align-items: center;
      min-height: 44px;
      padding: 4px;
    }

    .panel {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 7px;
      padding: 8px;
      border: 1px solid rgb(255 213 100 / 55%);
      border-radius: 15px;
      background:
        linear-gradient(180deg, rgb(255 255 255 / 8%), transparent 42%),
        var(--war-felt-texture), rgb(7 28 22 / 94%);
      background-size:
        auto,
        256px 256px,
        auto;
      box-shadow:
        0 10px 32px rgb(0 0 0 / 45%),
        inset 0 1px rgb(255 255 255 / 16%);
      backdrop-filter: blur(16px) saturate(130%);
    }

    p {
      grid-column: 1 / -1;
      min-width: 0;
      margin: 0 4px 1px;
      overflow-wrap: anywhere;
      color: rgb(246 241 223 / 78%);
    }

    header {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .disclosure {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      min-height: 36px;
      padding: 0 9px;
      border: 0;
      background: transparent;
      box-shadow: none;
      color: #f6f1df;
      text-align: left;
    }

    .disclosure:active {
      translate: 0;
      box-shadow: none;
    }

    .disclosure span:last-child {
      transition: transform 220ms ease;
    }

    .disclosure[aria-expanded="true"] span:last-child {
      transform: rotate(180deg);
    }

    .tools {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 7px;
      animation: reveal 260ms cubic-bezier(0.22, 0.72, 0.18, 1) both;
    }

    .tools label,
    .tools header {
      grid-column: 1 / -1;
    }

    @keyframes reveal {
      from {
        opacity: 0;
        transform: translateY(-6px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }

    a {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      min-height: 44px;
      padding-inline: 8px;
      color: #f6f1df;
      text-underline-offset: 3px;
    }

    button {
      min-width: 0;
      min-height: 40px;
      padding: 0 13px;
      border: 1px solid rgb(255 255 255 / 28%);
      border-radius: 11px;
      color: #172019;
      background: linear-gradient(#fff5c7, #dcae42);
      box-shadow:
        inset 0 1px rgb(255 255 255 / 80%),
        0 3px 0 #76531b;
      font: inherit;
      cursor: pointer;
      transition:
        translate 100ms ease,
        box-shadow 100ms ease,
        filter 100ms ease;
    }

    button:last-child {
      color: #f6f1df;
      background: linear-gradient(#586864, #263430);
      box-shadow:
        inset 0 1px rgb(255 255 255 / 25%),
        0 3px 0 #111916;
    }

    button:active:not(:disabled) {
      translate: 0 3px;
      box-shadow: inset 0 2px 4px rgb(0 0 0 / 35%);
      filter: brightness(0.94);
    }

    button:disabled {
      cursor: wait;
      filter: grayscale(0.45) brightness(0.72);
    }
  `;

  private run = async (preset: DebugPlaytestPreset): Promise<void> => {
    this.action = preset;
    this.status = "Finding game…";
    try {
      const status = (message: string) => (this.status = message);
      await quickJoinDebugGame(
        status,
        preset,
        this.longSession ? "1d" : "1h",
        true,
      );
      requestHaptic("success");
    } catch (error) {
      this.status =
        error instanceof Error ? error.message : "Debug action failed";
      requestHaptic("error");
    } finally {
      this.action = null;
    }
  };

  render() {
    return html`
      <aside class="panel" aria-label="Debug quick launch">
        <button
          class="disclosure"
          type="button"
          aria-expanded=${this.expanded}
          @click=${() => (this.expanded = !this.expanded)}
        >
          <span>${this.status}</span><span aria-hidden="true">⌄</span>
        </button>
        ${
          this.expanded
            ? html`<div class="tools">
                <header>
                  <p>Test controls</p>
                  <a href="/?ui-lab=hud">HUD preview</a>
                </header>
                <label>
                  <input
                    type="checkbox"
                    .checked=${this.longSession}
                    ?disabled=${this.action !== null}
                    @change=${(event: Event) => {
                      this.longSession = (
                        event.target as HTMLInputElement
                      ).checked;
                    }}
                  />
                  Long session (up to 24h; normal victories still apply)
                </label>
                <button
                  type="button"
                  ?disabled=${this.action !== null}
                  @click=${() => this.run("great-lakes")}
                >
                  ${this.action === "great-lakes" ? "Joining…" : "Great Lakes"}
                </button>
                <button
                  type="button"
                  ?disabled=${this.action !== null}
                  @click=${() => this.run("enormous-earth")}
                >
                  ${
                    this.action === "enormous-earth"
                      ? "Joining…"
                      : "Enormous Earth"
                  }
                </button>
                <button
                  type="button"
                  ?disabled=${this.action !== null}
                  @click=${() => this.run("hd-earth-9x")}
                >
                  ${this.action === "hd-earth-9x" ? "Joining…" : "9× HD Earth"}
                </button>
                <p>
                  9× HD Earth: experimental terrain. Boats may clip riverbanks.
                </p>
              </div>`
            : null
        }
      </aside>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "idlefront-debug-quick-launch": DebugQuickLaunch;
  }
}
