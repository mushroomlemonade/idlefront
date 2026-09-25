import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  CreatePersistentWorldRequest,
  PersistentWorldAccess,
  PersistentWorldDuration,
  PersistentWorldMode,
} from "../../../core/PersistentWorldSchemas";
import { pressurePacingForDuration } from "../../../core/PressurePacing";
import {
  CUSTOM_WORLD_PRESETS,
  isCurrentWorldPreset,
  WORLD_PRESETS,
  type WorldPreset,
} from "../../../core/WorldPresets";
import { placeholderCopy } from "../../copy/PlaceholderCopy";
import { formatWorldDate } from "./PersistentWorldComponents";
import { worldModeSummary } from "./WorldModeSummary";

interface SchedulePreset {
  id: string;
  label: string;
  description: string;
  value: () => number;
}

const startOfTomorrowEvening = (): number => {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(19, 0, 0, 0);
  return date.getTime();
};

const SCHEDULE_PRESETS: SchedulePreset[] = [
  {
    id: "soon",
    label: "In 10 minutes",
    description: placeholderCopy.wizard.scheduleDescription,
    value: () => Date.now() + 10 * 60 * 1000,
  },
  {
    id: "hour",
    label: "In one hour",
    description: placeholderCopy.wizard.scheduleDescription,
    value: () => Date.now() + 60 * 60 * 1000,
  },
  {
    id: "tomorrow",
    label: "Tomorrow evening",
    description: placeholderCopy.wizard.scheduleDescription,
    value: startOfTomorrowEvening,
  },
  {
    id: "week",
    label: "In one week",
    description: placeholderCopy.wizard.scheduleDescription,
    value: () => Date.now() + 7 * 24 * 60 * 60 * 1000,
  },
];

@customElement("persistent-world-creation-wizard")
export class PersistentWorldCreationWizard extends LitElement {
  @property({ type: Boolean }) submitting = false;
  @property({ type: Boolean }) departing = false;
  @property({ type: Boolean }) customGame = false;
  @state() private gamePreset: WorldPreset = "quickplay";
  @property() error = "";
  @state() private step = 0;
  @state() private name = "";
  @state() private duration: PersistentWorldDuration = "1h";
  @state() private pressurePacing = pressurePacingForDuration("1h");
  @state() private access: PersistentWorldAccess = "private";
  @state() private password = "";
  @state() private mode: PersistentWorldMode = "ffa";
  @state() private maxHumans = 8;
  @state() private teamId = "team-1";
  @state() private schedulePreset = "tomorrow";
  @state() private startsAt = startOfTomorrowEvening();
  @state() private exactSchedule = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    const preset = new URLSearchParams(window.location.search).get("preset");
    if (CUSTOM_WORLD_PRESETS.some((id) => id === preset)) {
      this.gamePreset = preset as WorldPreset;
      if (isCurrentWorldPreset(preset))
        this.duration = WORLD_PRESETS[preset].duration;
    }
    this.pressurePacing = pressurePacingForDuration(this.duration);
  }

  render() {
    const stepTitles = [
      placeholderCopy.wizard.worldTitle,
      placeholderCopy.wizard.playersTitle,
      "Start",
      "Invitation",
    ];
    const stepNames = ["World", "Players", "Start", "Invitation"];
    return html`
      <section
        class="pw-wizard ${this.departing ? "is-departing" : ""}"
        aria-labelledby="pw-wizard-title"
        aria-busy=${this.submitting || this.departing ? "true" : "false"}
      >
        <div class="pw-wizard__viewport">
          ${
            this.step === 0
              ? this.renderWorldStep()
              : this.step === 1
                ? this.renderPlayersStep()
                : this.step === 2
                  ? this.renderScheduleStep()
                  : this.renderInvitationStep()
          }
        </div>
        <div class="pw-wizard__command-panel">
          <header class="pw-wizard__header">
            <button
              class="pw-icon-button"
              type="button"
              aria-label="Close world setup"
              @click=${this.close}
            >
              ×
            </button>
            <div>
              <span class="pw-eyebrow" data-copy-slot="wizard.eyebrow"
                >${placeholderCopy.wizard.eyebrow}</span
              >
              <h1 id="pw-wizard-title">${stepTitles[this.step]}</h1>
            </div>
            <span class="pw-wizard__position"
              >${this.step + 1} of ${stepNames.length}</span
            >
          </header>

          <ol class="pw-wizard__progress" aria-label="Setup progress">
            ${stepNames.map(
            (label, index) => html`
              <li
                class=${
                  index === this.step
                    ? "is-current"
                    : index < this.step
                      ? "is-complete"
                      : ""
                }
              >
                <button
                  class="pw-wizard__step"
                  type="button"
                  aria-label=${`Go to ${label} step`}
                  aria-current=${index === this.step ? "step" : nothing}
                  ?disabled=${!this.canOpenStep(index)}
                  @click=${() => this.openStep(index)}
                >
                  <span>${index < this.step ? "✓" : index + 1}</span
                  ><small>${label}</small>
                </button>
              </li>
            `,
          )}
          </ol>

          ${
          this.error
            ? html`<div class="pw-alert" role="alert">${this.error}</div>`
            : nothing
        }

          <footer class="pw-wizard__footer">
            <button
              class="pw-button pw-button--secondary"
              type="button"
              @click=${this.back}
              ?disabled=${this.submitting || this.departing}
            >
              ${this.step === 0 ? "Cancel" : "Back"}
            </button>
            <button
              class="pw-button pw-button--primary"
              type="button"
              @click=${this.next}
              ?disabled=${this.submitting || this.departing || !this.canContinue()}
            >
              ${
              this.submitting
                ? "Preparing invitation…"
                : this.step === 3
                  ? "Create invitation"
                  : "Continue"
            }
            </button>
          </footer>
        </div>
      </section>
    `;
  }

  private renderWorldStep() {
    return html`
      <div class="pw-wizard-step pw-wizard-step--world">
        <div class="pw-wizard-step__intro">
          <span class="pw-step-number">01</span>
          <div>
            <h2 data-copy-slot="wizard.worldHeading">Choose your pace</h2>
            <p data-copy-slot="wizard.worldInstructions">
              Earth · choose a target duration and map size.
            </p>
          </div>
        </div>
        <label class="pw-field">
          <span>${placeholderCopy.wizard.worldNameLabel}</span>
          <input
            type="text"
            maxlength="100"
            autocomplete="off"
            placeholder=${placeholderCopy.wizard.worldNamePlaceholder}
            .value=${this.name}
            @input=${(event: Event) =>
              (this.name = (event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <fieldset class="pw-choice-grid pw-world-options">
          <legend>Game mode</legend>
          ${CUSTOM_WORLD_PRESETS.map(
            (id) =>
              html` <label
                class="pw-choice-card ${this.gamePreset === id ? "is-selected" : ""}"
              >
                <input
                  type="radio"
                  name="game-preset"
                  value=${id}
                  .checked=${this.gamePreset === id}
                  @change=${() => {
                    this.gamePreset = id;
                    this.duration = WORLD_PRESETS[id].duration;
                    this.pressurePacing = pressurePacingForDuration(
                      this.duration,
                    );
                  }}
                />
                <strong>${WORLD_PRESETS[id].label}</strong>
                ${worldModeSummary(id)}
              </label>`,
          )}
        </fieldset>
        ${
          this.customGame
            ? html`<div class="pw-settings-row">
                <label class="pw-field"
                  ><span
                    >${this.pressurePacing.populationGrowthMultiplier !== undefined ? "Population growth · native rate multiplier" : "Population growth · doubling time (seconds)"}</span
                  >
                  <input
                    type="number"
                    inputmode="decimal"
                    min=${this.pressurePacing.populationGrowthMultiplier !== undefined ? "0.01" : "60"}
                    max=${this.pressurePacing.populationGrowthMultiplier !== undefined ? "100" : "604800"}
                    step=${this.pressurePacing.populationGrowthMultiplier !== undefined ? "0.1" : "60"}
                    style="font-size:16px"
                    .value=${String(this.pressurePacing.populationGrowthMultiplier ?? this.pressurePacing.populationDoublingSeconds)}
                    @change=${(e: Event) => {
                      const n = Number((e.target as HTMLInputElement).value);
                      if (
                        this.pressurePacing.populationGrowthMultiplier !==
                        undefined
                      ) {
                        if (Number.isFinite(n))
                          this.pressurePacing = {
                            ...this.pressurePacing,
                            populationGrowthMultiplier: Math.max(
                              0.01,
                              Math.min(100, n),
                            ),
                          };
                        return;
                      }
                      if (Number.isFinite(n))
                        this.pressurePacing = {
                          ...this.pressurePacing,
                          populationDoublingSeconds: Math.max(
                            60,
                            Math.min(604800, n),
                          ),
                        };
                    }}
                  />
                </label>
                <label class="pw-field"
                  ><span>Mobilisation · halfway to target (seconds)</span>
                  <input
                    type="number"
                    inputmode="numeric"
                    min="1"
                    max="86400"
                    step="1"
                    style="font-size:16px"
                    .value=${String(this.pressurePacing.mobilisationHalfLifeSeconds)}
                    @change=${(e: Event) => {
                      const n = Number((e.target as HTMLInputElement).value);
                      if (Number.isFinite(n))
                        this.pressurePacing = {
                          ...this.pressurePacing,
                          mobilisationHalfLifeSeconds: Math.max(
                            1,
                            Math.min(86400, n),
                          ),
                        };
                    }}
                  />
                </label>
              </div>`
            : nothing
        }
        <p class="pw-disclosure">
          Manual and automatic mobilisation use the same rate. Growth slows near
          population capacity.
        </p>
        <p class="pw-disclosure" data-copy-slot="wizard.pacingDisclosure">
          ${placeholderCopy.wizard.pacingDisclosure}
        </p>
      </div>
    `;
  }

  private renderPlayersStep() {
    return html`
      <div class="pw-wizard-step">
        <div class="pw-wizard-step__intro">
          <span class="pw-step-number">02</span>
          <div>
            <h2 data-copy-slot="wizard.playersHeading">
              ${placeholderCopy.wizard.playersHeading}
            </h2>
            <p data-copy-slot="wizard.playersInstructions">
              ${placeholderCopy.wizard.playersInstructions}
            </p>
          </div>
        </div>
        <div class="pw-settings-row">
          <fieldset class="pw-choice-grid">
            <legend>Visibility</legend>
            ${this.binaryChoices(
              [
                [
                  "private",
                  "Private",
                  placeholderCopy.wizard.privateDescription,
                ],
                ["public", "Public", placeholderCopy.wizard.publicDescription],
              ],
              this.access,
              (value) => (this.access = value as PersistentWorldAccess),
              "access",
            )}
          </fieldset>
          ${
            this.customGame
              ? html`<fieldset class="pw-choice-grid">
                  <legend>Diplomacy</legend>
                  ${this.binaryChoices(
                    [
                      [
                        "ffa",
                        "Free for all",
                        placeholderCopy.wizard.freeForAllDescription,
                      ],
                      [
                        "teams",
                        "Teams",
                        placeholderCopy.wizard.teamsDescription,
                      ],
                    ],
                    this.mode,
                    (value) => (this.mode = value as PersistentWorldMode),
                    "mode",
                  )}
                </fieldset>`
              : html`<div class="pw-schedule-confirmation">
                  <span>Diplomacy</span><strong>Free for all</strong>
                </div>`
          }
        </div>
        ${
          this.access === "private"
            ? html`<label class="pw-field"
                ><span>Game password</span>
                <input
                  type="password"
                  autocomplete="new-password"
                  maxlength="128"
                  .value=${this.password}
                  @input=${(event: Event) => (this.password = (event.target as HTMLInputElement).value)}
                />
                <small
                  >Share this password and the invitation. Use the same username
                  to resume on another device.</small
                >
              </label>`
            : nothing
        }
        <div class="pw-stepper-field">
          <div>
            <span>${placeholderCopy.wizard.playerCountLabel}</span
            ><small data-copy-slot="wizard.playerCountDescription"
              >${placeholderCopy.wizard.playerCountDescription}</small
            >
          </div>
          <div class="pw-stepper">
            <button
              type="button"
              aria-label="Remove one commander"
              @click=${() => (this.maxHumans = Math.max(2, this.maxHumans - 1))}
            >
              −
            </button>
            <output>${this.maxHumans}</output>
            <button
              type="button"
              aria-label="Add one commander"
              @click=${() =>
                (this.maxHumans = Math.min(16, this.maxHumans + 1))}
            >
              +
            </button>
          </div>
        </div>
        ${
          this.mode === "teams"
            ? html`<label class="pw-field pw-field--compact"
                ><span>Your team</span>
                <select
                  .value=${this.teamId}
                  @change=${(event: Event) =>
                    (this.teamId = (
                      event.currentTarget as HTMLSelectElement
                    ).value)}
                >
                  <option value="team-1">Team 1</option>
                  <option value="team-2">Team 2</option>
                  <option value="team-3">Team 3</option>
                  <option value="team-4">Team 4</option>
                </select></label
              >`
            : nothing
        }
      </div>
    `;
  }

  private renderScheduleStep() {
    if (this.customGame)
      return html` <div class="pw-wizard-step">
        <div class="pw-wizard-step__intro">
          <span class="pw-step-number">03</span>
          <div>
            <h2>Start when ready</h2>
            <p>You control when this game begins.</p>
          </div>
        </div>
        <div class="pw-schedule-confirmation">
          <span>Host-controlled start</span>
          <strong>Invite players, then press Start game in the lobby.</strong>
          <small>No automatic countdown. You can also start on your own.</small>
        </div>
      </div>`;
    return html`
      <div class="pw-wizard-step">
        <div class="pw-wizard-step__intro">
          <span class="pw-step-number">03</span>
          <div>
            <h2 data-copy-slot="wizard.stepHeading">
              ${placeholderCopy.wizard.stepHeading}
            </h2>
            <p data-copy-slot="wizard.stepInstructions">
              ${placeholderCopy.wizard.stepInstructions}
            </p>
          </div>
        </div>
        <div class="pw-schedule-grid">
          ${SCHEDULE_PRESETS.map(
            (preset) => html`
              <button
                type="button"
                class="pw-schedule-card ${
                  !this.exactSchedule && this.schedulePreset === preset.id
                    ? "is-selected"
                    : ""
                }"
                @click=${() => this.selectPreset(preset)}
              >
                <strong>${preset.label}</strong
                ><small>${preset.description}</small>
              </button>
            `,
          )}
          <button
            type="button"
            class="pw-schedule-card ${this.exactSchedule ? "is-selected" : ""}"
            @click=${() => (this.exactSchedule = true)}
          >
            <strong>Exact date & time</strong
            ><small data-copy-slot="wizard.scheduleDescription"
              >${placeholderCopy.wizard.scheduleDescription}</small
            >
          </button>
        </div>
        ${
          this.exactSchedule
            ? html`<label class="pw-field"
                ><span>Local start time</span
                ><input
                  type="datetime-local"
                  .value=${this.toDateTimeLocal(this.startsAt)}
                  min=${this.toDateTimeLocal(Date.now() + 2 * 60 * 1000)}
                  max=${this.toDateTimeLocal(
                    Date.now() + 14 * 24 * 60 * 60 * 1000,
                  )}
                  @change=${this.updateExactTime}
              /></label>`
            : nothing
        }
        <div class="pw-schedule-confirmation">
          <span>Automatic launch</span
          ><strong>${formatWorldDate(this.startsAt)}</strong
          ><small>${Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
        </div>
      </div>
    `;
  }

  private renderInvitationStep() {
    return html`
      <div class="pw-wizard-step pw-wizard-step--review">
        <article class="pw-invitation-card pw-invitation-card--draft">
          <div class="pw-invitation-card__seal" aria-hidden="true">
            <span>IF</span>
          </div>
          <div class="pw-invitation-card__body">
            <div class="pw-eyebrow">
              ${this.access === "private" ? "Private invitation" : "Open world"}
            </div>
            <h1>${this.name.trim()}</h1>
            <p class="pw-invitation-card__date">
              ${this.customGame ? "Starts when the host is ready" : formatWorldDate(this.startsAt)}
            </p>
            <div class="pw-invitation-card__draft-status">
              <span aria-hidden="true"></span>
              Invitation ready to create
            </div>
            <dl class="pw-invitation-card__facts">
              <div>
                <dt>World</dt>
                <dd>${WORLD_PRESETS[this.gamePreset].label}</dd>
              </div>
              <div>
                <dt>Commanders</dt>
                <dd>0/${this.maxHumans}</dd>
              </div>
              <div>
                <dt>Format</dt>
                <dd>${this.mode === "ffa" ? "Free for all" : "Teams"}</dd>
              </div>
            </dl>
            ${worldModeSummary(this.gamePreset)}
          </div>
          <div class="pw-invitation-card__draft-note">
            <strong
              >${this.access === "private" ? "Invitation only" : "Public listing"}</strong
            >
            <span>${this.maxHumans} player slots</span>
          </div>
        </article>
        <div
          class="pw-disclosure pw-disclosure--emphasis"
          data-copy-slot="wizard.reviewDisclosure"
        >
          ${placeholderCopy.wizard.reviewDisclosure}
        </div>
      </div>
    `;
  }

  private binaryChoices(
    choices: [string, string, string][],
    current: string,
    update: (value: string) => void,
    name: string,
  ) {
    return choices.map(
      ([value, label, detail]) => html`
        <label
          class="pw-choice-card pw-choice-card--horizontal ${
            current === value ? "is-selected" : ""
          }"
        >
          <input
            type="radio"
            name=${name}
            value=${value}
            .checked=${current === value}
            @change=${() => update(value)}
          />
          <span><strong>${label}</strong><small>${detail}</small></span>
        </label>
      `,
    );
  }

  private selectPreset(preset: SchedulePreset) {
    this.exactSchedule = false;
    this.schedulePreset = preset.id;
    this.startsAt = preset.value();
  }

  private updateExactTime = (event: Event) => {
    const value = (event.currentTarget as HTMLInputElement).value;
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) this.startsAt = timestamp;
  };

  private toDateTimeLocal(timestamp: number): string {
    const date = new Date(
      timestamp - new Date(timestamp).getTimezoneOffset() * 60_000,
    );
    return date.toISOString().slice(0, 16);
  }

  private canContinue(): boolean {
    if (this.step === 0) return this.name.trim().length > 0;
    if (this.step === 2) return this.hasValidSchedule();
    return true;
  }

  private hasValidSchedule(): boolean {
    if (this.customGame) return true;
    return (
      this.startsAt >= Date.now() + 60_000 &&
      this.startsAt <= Date.now() + 14 * 24 * 60 * 60 * 1000
    );
  }

  private canOpenStep(index: number): boolean {
    if (this.submitting || this.departing) return false;
    if (index <= this.step) return true;
    if (index > 0 && this.name.trim().length === 0) return false;
    if (index > 2 && !this.hasValidSchedule()) return false;
    return true;
  }

  private openStep(index: number) {
    if (!this.canOpenStep(index)) return;
    this.error = "";
    this.step = index;
  }

  private next = () => {
    if (!this.canContinue()) return;
    if (this.step < 3) {
      this.step += 1;
      return;
    }
    const input: CreatePersistentWorldRequest = {
      startMode: this.customGame ? "host" : "scheduled",
      gamePreset: this.gamePreset,
      name: this.name.trim(),
      targetDuration: this.duration,
      ...(this.customGame ? { pressurePacing: this.pressurePacing } : {}),
      access: this.access,
      ...(this.access === "private" && this.password
        ? { password: this.password }
        : {}),
      mode: this.customGame ? this.mode : "ffa",
      maxHumans: this.maxHumans,
      startsAt: this.startsAt,
      teamId: this.customGame && this.mode === "teams" ? this.teamId : null,
    };
    this.dispatchEvent(
      new CustomEvent("world-create", {
        detail: { input },
        bubbles: true,
        composed: true,
      }),
    );
  };

  private back = () => {
    if (this.step === 0) return this.close();
    this.step -= 1;
  };

  private close = () => {
    this.dispatchEvent(
      new CustomEvent("world-wizard-close", { bubbles: true, composed: true }),
    );
  };
}
