import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import quickChatData from "resources/QuickChat.json";
import type {
  PersistentWorldCard,
  PersistentWorldLobbyMemberView,
  PersistentWorldLobbySnapshot,
  PersistentWorldQuickChatView,
} from "../../../core/PersistentWorldSchemas";
import { WORLD_PRESETS } from "../../../core/WorldPresets";
import { placeholderCopy } from "../../copy/PlaceholderCopy";
import { translateText } from "../../Utils";
import "../ProductWordmark";
import { worldModeSummary } from "./WorldModeSummary";

@customElement("idlefront-wordmark")
export class IdleFrontWordmark extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`<product-wordmark compact></product-wordmark>`;
  }
}

export function formatWorldDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function formatWorldDuration(duration: "1h" | "1d" | "7d"): string {
  return { "1h": "One hour", "1d": "One day", "7d": "One week" }[duration];
}

export function formatLeadTime(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} seconds before`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60)
    return `${minutes} minute${minutes === 1 ? "" : "s"} before`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} before`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} before`;
}

function compactCountdown(milliseconds: number): string {
  if (milliseconds <= 0) return "Starting now";
  const seconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}

@customElement("persistent-world-countdown")
export class PersistentWorldCountdown extends LitElement {
  @property({ type: Number, attribute: "starts-at" }) startsAt = 0;
  @property({ type: Number, attribute: "server-time" }) serverTime = 0;
  @property() phase: "scheduled" | "active" | "finished" | "cancelled" =
    "scheduled";
  @state() private now = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private serverOffset = 0;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.syncClock();
    this.timer = setInterval(() => {
      this.now = Date.now() + this.serverOffset;
    }, 1000);
  }

  disconnectedCallback() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    if (changed.has("serverTime")) this.syncClock();
  }

  render() {
    const label =
      this.phase === "active"
        ? "World underway"
        : this.phase === "finished"
          ? "World complete"
          : this.phase === "cancelled"
            ? "Invitation cancelled"
            : compactCountdown(this.startsAt - this.now);
    return html`<span
      class="pw-countdown pw-countdown--${this.phase}"
      role="timer"
    >
      <span class="pw-countdown__lamp" aria-hidden="true"></span>
      <span>${label}</span>
    </span>`;
  }

  private syncClock() {
    this.serverOffset = this.serverTime ? this.serverTime - Date.now() : 0;
    this.now = Date.now() + this.serverOffset;
  }
}

@customElement("persistent-world-invitation-card")
export class PersistentWorldInvitationCard extends LitElement {
  @property({ attribute: false }) snapshot?: PersistentWorldLobbySnapshot;
  @property({ attribute: "share-url" }) shareUrl = "";

  createRenderRoot() {
    return this;
  }

  render() {
    const snapshot = this.snapshot;
    if (!snapshot) return nothing;
    const world = snapshot.world;
    return html`
      <article class="pw-invitation-card">
        <div class="pw-invitation-card__seal" aria-hidden="true">
          <span>IF</span>
        </div>
        <div class="pw-invitation-card__body">
          <div class="pw-eyebrow">
            ${world.access === "private" ? "Private invitation" : "Open world"}
          </div>
          <h1>${world.name}</h1>
          <p class="pw-invitation-card__date">
            ${world.startMode === "host" && world.phase === "scheduled" ? "Starts when the host is ready" : formatWorldDate(world.startsAt)}
          </p>
          ${
            world.phase === "active" && snapshot.viewer.isMember
              ? html`<button
                  class="pw-countdown pw-entry-control"
                  type="button"
                  aria-label=${
                    snapshot.runtimeGameId ? "Play world" : "Preparing map"
                  }
                  title=${
                    snapshot.runtimeGameId
                      ? "Return to world"
                      : "Preparing the game map"
                  }
                  ?disabled=${!snapshot.runtimeGameId}
                  @click=${() => this.enterRuntime(snapshot.runtimeGameId)}
                >
                  <span class="pw-entry-control__icon" aria-hidden="true"
                    >${snapshot.runtimeGameId ? "▶" : "…"}</span
                  >
                  <span
                    >${
                      snapshot.runtimeGameId ? "Play world" : "Preparing map…"
                    }</span
                  >
                </button>`
              : world.startMode === "host" && world.phase === "scheduled"
                ? html`<div class="pw-countdown" role="status">
                    Waiting for the host
                  </div>`
                : html`<persistent-world-countdown
                    .startsAt=${world.startsAt}
                    .serverTime=${snapshot.serverTime}
                    .phase=${world.phase}
                  ></persistent-world-countdown>`
          }
          <dl class="pw-invitation-card__facts">
            <div>
              <dt>${world.gamePreset ? "World" : "Pace"}</dt>
              <dd>
                ${world.gamePreset ? WORLD_PRESETS[world.gamePreset].label : formatWorldDuration(world.targetDuration)}
              </dd>
            </div>
            <div>
              <dt>Commanders</dt>
              <dd>${snapshot.members.length}/${world.maxHumans}</dd>
            </div>
            <div>
              <dt>Format</dt>
              <dd>${world.mode === "ffa" ? "Free for all" : "Teams"}</dd>
            </div>
          </dl>
          ${worldModeSummary(world.gamePreset)}
        </div>
        ${
          world.phase === "scheduled" || world.phase === "active"
            ? html`<button
                class="pw-text-button pw-text-button--danger pw-dev-end"
                type="button"
                ?disabled=${!this.snapshot?.viewer.identity}
                title="Temporary development control"
                @click=${this.endWorldForDevelopment}
              >
                DEV · End world
              </button>`
            : nothing
        }
        <button
          class="pw-button pw-button--share"
          type="button"
          @click=${this.share}
          ?disabled=${!this.shareUrl}
        >
          <span aria-hidden="true">↗</span>
          <span>Share invitation</span>
        </button>
      </article>
    `;
  }

  private async share() {
    if (!this.shareUrl) return;
    const title = this.snapshot?.world.name ?? "Join my world";
    try {
      if (navigator.share) {
        await navigator.share({
          title,
          text: `Join ${title}`,
          url: this.shareUrl,
        });
        this.dispatchShareStatus("Invitation shared");
      } else {
        await navigator.clipboard.writeText(this.shareUrl);
        this.dispatchShareStatus("Invitation copied");
      }
    } catch (error) {
      if ((error as DOMException).name === "AbortError") return;
      this.dispatchEvent(
        new CustomEvent("world-share-failed", {
          detail: { url: this.shareUrl },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private dispatchShareStatus(message: string) {
    this.dispatchEvent(
      new CustomEvent("world-share-status", {
        detail: { message },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private enterRuntime(runtimeGameId: string | null) {
    if (!runtimeGameId) return;
    this.dispatchEvent(
      new CustomEvent("world-enter-runtime", {
        detail: { gameId: runtimeGameId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private endWorldForDevelopment() {
    this.dispatchEvent(
      new CustomEvent("world-dev-end", {
        bubbles: true,
        composed: true,
      }),
    );
  }
}

@customElement("persistent-world-roster")
export class PersistentWorldRoster extends LitElement {
  @property({ attribute: false }) members: PersistentWorldLobbyMemberView[] =
    [];
  @property({ type: Number, attribute: "max-humans" }) maxHumans = 2;
  @property() mode: "ffa" | "teams" = "ffa";

  createRenderRoot() {
    return this;
  }

  render() {
    const sorted = [...this.members].sort(
      (a, b) =>
        Number(b.isHost) - Number(a.isHost) ||
        Number(b.presence === "online") - Number(a.presence === "online") ||
        a.joinedAt - b.joinedAt,
    );
    return html`
      <section class="pw-panel pw-roster" aria-labelledby="pw-roster-title">
        <header class="pw-panel__header">
          <div>
            <span class="pw-eyebrow" data-copy-slot="lobby.rosterEyebrow"
              >${placeholderCopy.lobby.rosterEyebrow}</span
            >
            <h2 id="pw-roster-title">Commanders</h2>
          </div>
          <span class="pw-panel__count"
            >${this.members.length}/${this.maxHumans}</span
          >
        </header>
        <div class="pw-roster__list pw-intentional-scroll">
          ${sorted.map((member, index) => this.renderMember(member, index))}
          ${Array.from(
            {
              length: Math.min(3, Math.max(0, this.maxHumans - sorted.length)),
            },
            (_, index) => html`
              <div class="pw-roster-row pw-roster-row--open">
                <span class="pw-roster-row__number"
                  >${sorted.length + index + 1}</span
                >
                <span>Open seat</span>
              </div>
            `,
          )}
        </div>
      </section>
    `;
  }

  private renderMember(member: PersistentWorldLobbyMemberView, index: number) {
    const initial = member.identity.displayName.slice(0, 1).toUpperCase();
    return html`
      <div class="pw-roster-row ${member.isViewer ? "is-viewer" : ""}">
        <span class="pw-roster-row__number">${index + 1}</span>
        <span class="pw-avatar" aria-hidden="true">${initial}</span>
        <span class="pw-roster-row__identity">
          <strong>${member.identity.displayName}</strong>
          <small>
            ${
              member.isHost
                ? "Host"
                : this.mode === "teams" && member.teamId
                  ? member.teamId
                  : "Joined"
            }
          </small>
        </span>
        <span class="pw-presence pw-presence--${member.presence}">
          <span aria-hidden="true"></span>${member.presence}
        </span>
      </div>
    `;
  }
}

interface QuickChatEntry {
  key: string;
  requiresPlayer: boolean;
}

const lobbyQuickChat = Object.entries(quickChatData).map(
  ([category, entries]) => ({
    category,
    entries: (entries as QuickChatEntry[]).filter(
      (entry) => !entry.requiresPlayer,
    ),
  }),
);

export function quickChatLabel(key: string): string {
  const translated = translateText(`chat.${key}`);
  return translated === `chat.${key}` ? key.replace(/[._]/g, " ") : translated;
}

@customElement("persistent-world-quick-chat")
export class PersistentWorldQuickChat extends LitElement {
  @property({ attribute: false }) messages: PersistentWorldQuickChatView[] = [];
  @property({ type: Boolean }) disabled = false;
  @state() private selectedCategory = "greet";
  @state() private selectedPhraseKey: string | null = null;
  @state() private sendingKey: string | null = null;

  createRenderRoot() {
    return this;
  }

  render() {
    const category =
      lobbyQuickChat.find((item) => item.category === this.selectedCategory) ??
      lobbyQuickChat[0];
    const sendLabel = translateText("chat.send");
    const isSending = this.sendingKey !== null;
    return html`
      <section class="pw-panel pw-chat" aria-labelledby="pw-chat-title">
        <header class="pw-panel__header">
          <div>
            <span class="pw-eyebrow" data-copy-slot="lobby.chatEyebrow"
              >${placeholderCopy.lobby.chatEyebrow}</span
            >
            <h2 id="pw-chat-title">Quick chat</h2>
          </div>
          <span class="pw-panel__hint" data-copy-slot="lobby.chatHint"
            >${placeholderCopy.lobby.chatHint}</span
          >
        </header>
        <div class="pw-chat__messages pw-intentional-scroll" aria-live="polite">
          ${
            this.messages.length === 0
              ? html`<div class="pw-empty-state pw-empty-state--compact">
                  <strong data-copy-slot="lobby.chatEmptyHeading"
                    >${placeholderCopy.lobby.chatEmptyHeading}</strong
                  >
                  <span data-copy-slot="lobby.chatEmptyDescription"
                    >${placeholderCopy.lobby.chatEmptyDescription}</span
                  >
                </div>`
              : this.messages.map(
                  (message) => html`
                    <div class="pw-chat-message">
                      <span class="pw-chat-message__sender"
                        >${message.sender.displayName}</span
                      >
                      <span>${quickChatLabel(message.phraseKey)}</span>
                      <time datetime=${new Date(message.sentAt).toISOString()}
                        >${new Intl.DateTimeFormat(undefined, {
                          hour: "numeric",
                          minute: "2-digit",
                        }).format(message.sentAt)}</time
                      >
                    </div>
                  `,
                )
          }
        </div>
        <div class="pw-chat__composer ${this.disabled ? "is-disabled" : ""}">
          <div class="pw-chat__catalog">
            <div class="pw-chat__catalog-column">
              <span class="pw-chat__catalog-title"
                >${translateText("chat.category")}</span
              >
              <div
                class="pw-chat__categories pw-intentional-scroll"
                role="tablist"
                aria-label="Quick chat category"
              >
                ${lobbyQuickChat.map(
                  (item) => html`
                    <button
                      type="button"
                      role="tab"
                      aria-selected=${item.category === category.category}
                      class=${
                        item.category === category.category ? "is-active" : ""
                      }
                      @click=${() => this.selectCategory(item.category)}
                    >
                      ${quickChatLabel(`cat.${item.category}`)}
                    </button>
                  `,
                )}
              </div>
            </div>
            <div class="pw-chat__catalog-column">
              <span class="pw-chat__catalog-title"
                >${translateText("chat.phrase")}</span
              >
              <div
                class="pw-chat__phrases pw-intentional-scroll"
                role="tabpanel"
              >
                ${category.entries.map((entry) => {
                  const fullKey = `${category.category}.${entry.key}`;
                  return html`
                    <button
                      class="pw-phrase-button ${
                        this.selectedPhraseKey === fullKey ? "is-selected" : ""
                      }"
                      type="button"
                      aria-pressed=${this.selectedPhraseKey === fullKey}
                      ?disabled=${this.disabled || this.sendingKey !== null}
                      @click=${() => (this.selectedPhraseKey = fullKey)}
                    >
                      ${quickChatLabel(fullKey)}
                    </button>
                  `;
                })}
              </div>
            </div>
          </div>
          <p
            class="pw-chat__catalog-note"
            data-copy-slot="lobby.chatInstructions"
          >
            ${placeholderCopy.lobby.chatInstructions}
          </p>
          <div class="pw-chat__preview">
            <span>Preview</span>
            <strong
              >${
                this.selectedPhraseKey
                  ? quickChatLabel(this.selectedPhraseKey)
                  : translateText("chat.build")
              }</strong
            >
            <button
              class="pw-button pw-button--share pw-chat__send-button ${
                isSending ? "is-sending" : ""
              }"
              type="button"
              aria-busy=${isSending ? "true" : "false"}
              aria-label=${isSending ? "Sending quick chat" : sendLabel}
              ?disabled=${
                this.disabled || isSending || this.selectedPhraseKey === null
              }
              @click=${this.sendSelected}
            >
              <span class="pw-chat__send-label" aria-hidden="true">
                <span class="pw-chat__send-label--idle">${sendLabel}</span>
                <span class="pw-chat__send-label--busy">Sending…</span>
              </span>
            </button>
          </div>
          ${
            this.disabled
              ? html`<p class="pw-chat__gate">
                  RSVP to take part in lobby chat.
                </p>`
              : nothing
          }
        </div>
      </section>
    `;
  }

  public sendingComplete() {
    this.sendingKey = null;
  }

  private selectCategory(category: string) {
    this.selectedCategory = category;
    this.selectedPhraseKey = null;
  }

  private sendSelected = () => {
    if (this.selectedPhraseKey) this.send(this.selectedPhraseKey);
  };

  private send(phraseKey: string) {
    this.sendingKey = phraseKey;
    this.dispatchEvent(
      new CustomEvent("world-quick-chat", {
        detail: { phraseKey },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

@customElement("persistent-world-reminder-picker")
export class PersistentWorldReminderPicker extends LitElement {
  @property({ attribute: false }) options: number[] = [];
  @property({ attribute: false }) selected: number[] = [];
  @property({ type: Boolean }) disabled = false;

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <section
        class="pw-panel pw-reminders"
        aria-labelledby="pw-reminders-title"
      >
        <header class="pw-panel__header">
          <div>
            <span class="pw-eyebrow" data-copy-slot="lobby.reminderEyebrow"
              >${placeholderCopy.lobby.reminderEyebrow}</span
            >
            <h2 id="pw-reminders-title">Notify me</h2>
          </div>
        </header>
        <div class="pw-reminders__options">
          ${this.options.map(
            (option) => html`
              <label class="pw-reminder-option">
                <input
                  type="checkbox"
                  .checked=${this.selected.includes(option)}
                  ?disabled=${this.disabled}
                  @change=${(event: Event) =>
                    this.toggle(
                      option,
                      (event.currentTarget as HTMLInputElement).checked,
                    )}
                />
                <span
                  class="pw-reminder-option__control"
                  aria-hidden="true"
                ></span>
                <span>${formatLeadTime(option)}</span>
              </label>
            `,
          )}
        </div>
        <p data-copy-slot="lobby.reminderDescription">
          ${placeholderCopy.lobby.reminderDescription}
        </p>
      </section>
    `;
  }

  private toggle(option: number, checked: boolean) {
    const selected = checked
      ? [...new Set([...this.selected, option])]
      : this.selected.filter((value) => value !== option);
    this.dispatchEvent(
      new CustomEvent("world-reminders-change", {
        detail: { leadTimesMs: selected },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

@customElement("persistent-world-list")
export class PersistentWorldList extends LitElement {
  @property() heading = "Worlds";
  @property() eyebrow = "";
  @property({ attribute: false }) worlds: PersistentWorldCard[] = [];
  @property() emptyHeading = "Nothing on the table.";
  @property() emptyMessage = "No worlds are waiting yet.";

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <section class="pw-world-list" aria-label=${this.heading}>
        <header class="pw-world-list__header">
          <div>
            <span class="pw-eyebrow">${this.eyebrow}</span>
            <h2>${this.heading}</h2>
          </div>
          <span>${this.worlds.length}</span>
        </header>
        <div class="pw-world-list__cards pw-intentional-scroll">
          ${
            this.worlds.length === 0
              ? html`<div class="pw-empty-state">
                  <strong>${this.emptyHeading}</strong
                  ><span>${this.emptyMessage}</span>
                </div>`
              : this.worlds.map((card) => this.renderCard(card))
          }
        </div>
      </section>
    `;
  }

  private renderCard(card: PersistentWorldCard) {
    const world = card.world;
    return html`
      <button
        class="pw-world-card${
          card.viewerEliminated ? " pw-world-card--eliminated" : ""
        }"
        type="button"
        aria-label=${
          card.viewerEliminated
            ? `${world.name}, eliminated, open spectator view`
            : `Open ${world.name}`
        }
        @click=${() =>
          this.dispatchEvent(
            new CustomEvent("world-open", {
              detail: { worldId: world.id },
              bubbles: true,
              composed: true,
            }),
          )}
      >
        <span
          class="pw-world-card__status pw-world-card__status--${
            card.viewerEliminated ? "eliminated" : world.phase
          }"
          >${card.viewerEliminated ? "Eliminated" : world.startMode === "host" && world.phase === "scheduled" ? "Waiting" : world.phase}</span
        >
        <span class="pw-world-card__copy">
          <strong>${world.name}</strong>
          <small
            >Hosted by ${card.host.displayName} ·
            ${world.startMode === "host" && world.phase === "scheduled" ? "Host starts when ready" : formatWorldDate(world.startsAt)}${
              card.viewerEliminated ? " · Spectate only" : ""
            }</small
          >
          ${world.gamePreset ? html`<small>${WORLD_PRESETS[world.gamePreset].label}</small>` : nothing}
          ${worldModeSummary(world.gamePreset)}
        </span>
        <span class="pw-world-card__facts">
          <span>${formatWorldDuration(world.targetDuration)}</span>
          <span>${card.rsvpCount}/${world.maxHumans}</span>
          <span>${world.mode === "ffa" ? "FFA" : "Teams"}</span>
        </span>
        <span class="pw-world-card__chevron" aria-hidden="true">›</span>
      </button>
    `;
  }
}
