import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type {
  CreatePersistentWorldRequest,
  PersistentWorldCard,
  PersistentWorldControllerSession,
  PersistentWorldLobbySnapshot,
} from "../../../core/PersistentWorldSchemas";
import { UsernameSchema } from "../../../core/Schemas";
import { getPlayToken, setGuestPlayToken } from "../../Auth";
import { placeholderCopy } from "../../copy/PlaceholderCopy";
import type { JoinLobbyEvent } from "../../Main";
import {
  consumeInvitationFragment,
  invitationForWorld,
  persistentWorldApi,
  PersistentWorldApiError,
  persistentWorldShareUrl,
  rememberInvitation,
} from "../../PersistentWorldApi";
import "./PersistentWorldComponents";
import { PersistentWorldQuickChat } from "./PersistentWorldComponents";
import "./PersistentWorldCreationWizard";

type WorldPageView = "hub" | "wizard" | "lobby" | "identity";
type LobbyTab = "invitation" | "roster" | "chat";
type IdentityContinuation = "create" | "rsvp";
type HeaderNoticeTone = "info" | "warning" | "error";

interface HeaderNotice {
  message: string;
  tone: HeaderNoticeTone;
}

const LOBBY_POLL_INTERVAL_MS = 3_000;
const HEADER_NOTICE_DURATION_MS = 6_500;

@customElement("persistent-world-page")
export class PersistentWorldPage extends LitElement {
  /** Explicit landing submission, unlike passive restoration on a deep link. */
  public async signIn(displayName: string): Promise<void> {
    const name = UsernameSchema.parse(displayName.trim());
    const previous = persistentWorldApi.sessionToken()
      ? await persistentWorldApi.resumeSession().catch((error) => {
          if (error instanceof PersistentWorldApiError && error.status === 401)
            return null;
          throw error;
        })
      : null;
    const session =
      previous?.identity.displayName === name
        ? previous
        : (await persistentWorldApi.createGuestSession(name)).session;
    this.session = null;
    setGuestPlayToken(null);
    const credential = await persistentWorldApi.bindGameIdentityWithToken(
      await getPlayToken(),
    );
    if (credential !== null) setGuestPlayToken(credential);
    this.session = session;
  }

  @state() private view: WorldPageView = "hub";
  @state() private lobbyTab: LobbyTab = "invitation";
  @state() private session: PersistentWorldControllerSession | null = null;
  @state() private publicWorlds: PersistentWorldCard[] = [];
  @state() private myWorlds: PersistentWorldCard[] = [];
  @state() private snapshot: PersistentWorldLobbySnapshot | null = null;
  @state() private loading = true;
  @state() private submitting = false;
  @state() private wizardDeparting = false;
  @state() private customGame = false;
  @state() private error = "";
  @state() private notice: HeaderNotice | null = null;
  @state() private identityName = "";
  @state() private gamePassword = "";
  @state() private identityContinuation: IdentityContinuation = "create";
  @state() private invitationSecret: string | null = null;
  @state() private selectedTeam = "team-1";
  @state() private confirmingLeave = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollingWorldId: string | null = null;
  private autoEnterWorldId: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private loadSequence = 0;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("focus", this.refreshVisibleLobby);
    this.routeFromLocation();
  }

  disconnectedCallback() {
    this.stopPolling();
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    window.removeEventListener("focus", this.refreshVisibleLobby);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    super.disconnectedCallback();
  }

  /** Navigation calls this for page-content components that expose `open`. */
  public open() {
    this.routeFromLocation();
  }

  public close() {
    this.navigate("/");
  }

  render() {
    return html`
      <div class="pw-app ${this.view === "lobby" ? "pw-app--lobby" : ""}">
        ${
          this.view === "identity"
            ? this.renderIdentity()
            : this.view === "wizard"
              ? html`<persistent-world-creation-wizard
                  .customGame=${this.customGame}
                  .submitting=${this.submitting}
                  .departing=${this.wizardDeparting}
                  .error=${this.error}
                  @world-create=${this.createWorld}
                  @world-wizard-close=${this.returnFromWizard}
                ></persistent-world-creation-wizard>`
              : html`${this.renderHeader()}${
                  this.view === "hub" ? this.renderHub() : this.renderLobby()
                }`
        }
      </div>
    `;
  }

  private renderHeader() {
    const inLobby = this.view === "lobby";
    const statusMessage =
      this.notice?.message ??
      (inLobby
        ? this.loading
          ? "Synchronizing lobby"
          : "Roster link active"
        : this.loading
          ? "Contacting world service"
          : "World service ready");
    const statusTone = this.notice?.tone ?? "info";
    const statusGlyph =
      statusTone === "error"
        ? html`<svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="7.5"></circle>
            <path d="m8.5 15.5 7-7"></path>
          </svg>`
        : statusTone === "warning"
          ? html`<svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 18V6"></path>
              <path d="M7 12c4.4 0 7.7-1.8 10-5"></path>
              <path d="M7 12c4.4 0 7.7 1.8 10 5"></path>
              <circle cx="17" cy="7" r="1.15"></circle>
              <circle cx="17" cy="17" r="1.15"></circle>
            </svg>`
          : html`<svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="6.25"></circle>
              <circle cx="12" cy="12" r="1.55"></circle>
              <path d="M12 2.75v3M12 18.25v3M2.75 12h3M18.25 12h3"></path>
            </svg>`;
    return html`
      <header class="pw-app-header">
        <button
          class="pw-icon-button pw-app-header__back"
          type="button"
          aria-label=${inLobby ? "Back to worlds" : "Back to home"}
          @click=${() => (inLobby ? this.showHub() : this.navigate("/"))}
        >
          <span aria-hidden="true">‹</span>
        </button>
        <idlefront-wordmark></idlefront-wordmark>
        <div class="pw-app-header__context">
          <span>${inLobby ? "Invitation lobby" : "Persistent worlds"}</span>
          ${
            this.session
              ? html`<strong>${this.session.identity.displayName}</strong>`
              : html`<strong>Guest view</strong>`
          }
        </div>
        <div
          class="pw-header-signal pw-header-signal--${statusTone}"
          role=${statusTone === "error" ? "alert" : "status"}
          aria-live=${statusTone === "error" ? "assertive" : "polite"}
          aria-atomic="true"
        >
          ${keyed(
            `${statusTone}:${statusMessage}`,
            html`<div class="pw-header-signal__board">
              <span
                class="pw-header-signal__glyph pw-header-signal__glyph--${statusTone}"
                aria-hidden="true"
                >${statusGlyph}</span
              >
              <span class="pw-header-signal__viewport" title=${statusMessage}>
                <span class="pw-header-signal__message">${statusMessage}</span>
              </span>
              <span class="pw-header-signal__lamp" aria-hidden="true"></span>
            </div>`,
          )}
        </div>
        ${
          !inLobby
            ? html`<button
                class="pw-header-action"
                type="button"
                @click=${this.beginCreate}
              >
                <span class="pw-header-action__plus" aria-hidden="true"
                  ><svg viewBox="0 0 20 20" focusable="false">
                    <path d="M10 4.25v11.5M4.25 10h11.5" /></svg></span
                ><span>New world</span>
              </button>`
            : html`<button
                class="pw-header-action pw-header-action--quiet"
                type="button"
                @click=${this.refreshLobby}
                ?disabled=${this.loading}
              >
                <span class="pw-refresh-mark" aria-hidden="true">↻</span
                ><span>Refresh</span>
              </button>`
        }
      </header>
    `;
  }

  private renderHub() {
    return html`
      <main class="pw-hub">
        <section class="pw-hub__intro">
          <div>
            <span class="pw-eyebrow" data-copy-slot="worlds.eyebrow"
              >${placeholderCopy.worlds.eyebrow}</span
            >
            <h1 data-copy-slot="worlds.heading">
              ${placeholderCopy.worlds.heading}
            </h1>
            <p data-copy-slot="worlds.description">
              ${placeholderCopy.worlds.description}
            </p>
          </div>
          <div class="pw-hub__actions">
            <button
              class="pw-button pw-button--primary pw-hub__create"
              type="button"
              @click=${this.beginCreate}
            >
              <span class="pw-button__medallion" aria-hidden="true">＋</span>
              <span
                ><strong data-copy-slot="worlds.primaryAction"
                  >make a lobby</strong
                ><small data-copy-slot="worlds.primaryActionDetail"
                  >Scheduled · Enormous Earth · 4×</small
                ></span
              >
            </button>
            <button
              class="pw-button pw-button--secondary pw-hub__create"
              type="button"
              @click=${() => this.beginCustomGame()}
            >
              <span class="pw-button__medallion" aria-hidden="true">◇</span>
              <span
                ><strong>custom game</strong
                ><small>Choose a world · start when ready</small></span
              >
            </button>
          </div>
        </section>
        ${
          this.error && !this.loading
            ? this.renderError("The world table is unavailable.", this.loadHub)
            : this.loading
              ? this.renderHubLoading()
              : html`
                  <div class="pw-hub__lists">
                    <persistent-world-list
                      heading=${placeholderCopy.worlds.playerListHeading}
                      eyebrow=${placeholderCopy.worlds.playerListEyebrow}
                      emptyHeading=${placeholderCopy.worlds.playerListEmptyHeading}
                      emptyMessage=${placeholderCopy.worlds.playerListEmpty}
                      .worlds=${this.myWorlds}
                      @world-open=${this.openWorldEvent}
                    ></persistent-world-list>
                    <persistent-world-list
                      heading=${placeholderCopy.worlds.publicListHeading}
                      eyebrow=${placeholderCopy.worlds.publicListEyebrow}
                      emptyMessage=${placeholderCopy.worlds.publicListEmpty}
                      .worlds=${this.publicWorlds}
                      @world-open=${this.openWorldEvent}
                    ></persistent-world-list>
                  </div>
                `
        }
      </main>
    `;
  }

  private renderHubLoading() {
    return html`
      <div
        class="pw-hub__lists pw-loading-table"
        aria-label="Loading worlds"
        aria-busy="true"
      >
        ${[0, 1].map(
          (column) => html`
            <section class="pw-world-list">
              <div
                class="pw-skeleton pw-skeleton--heading"
                style=${`--pw-delay:${column * 90}ms`}
              ></div>
              <div class="pw-world-list__cards">
                ${[0, 1, 2].map(
                  (row) =>
                    html`<div
                      class="pw-skeleton pw-skeleton--card"
                      style=${`--pw-delay:${column * 90 + row * 70}ms`}
                    >
                      <span></span><span></span><span></span>
                    </div>`,
                )}
              </div>
            </section>
          `,
        )}
      </div>
    `;
  }

  private renderLobby() {
    if (this.loading && !this.snapshot) return this.renderLobbyLoading();
    if (this.error && !this.snapshot) {
      return html`<main class="pw-lobby pw-lobby--error">
        ${this.renderError(
          "This invitation could not be opened.",
          this.refreshLobby,
        )}
      </main>`;
    }
    const snapshot = this.snapshot;
    if (!snapshot) return nothing;
    const world = snapshot.world;
    const isPendingRuntime =
      world.phase === "active" && !snapshot.runtimeGameId;
    const secret = this.invitationSecret ?? invitationForWorld(world.id);
    const shareUrl = persistentWorldShareUrl(world.id, secret);
    return html`
      <main class="pw-lobby">
        <nav class="pw-lobby-tabs" aria-label="Lobby sections">
          ${(["invitation", "roster", "chat"] as const).map(
            (tab) =>
              html`<button
                type="button"
                class=${this.lobbyTab === tab ? "is-active" : ""}
                @click=${() => (this.lobbyTab = tab)}
              >
                ${
                  tab === "invitation"
                    ? "World"
                    : tab === "roster"
                      ? `Roster · ${snapshot.members.length}`
                      : "Chat"
                }
              </button>`,
          )}
        </nav>
        <div class="pw-lobby__composition">
          <div
            class="pw-lobby__invitation ${
              this.lobbyTab === "invitation" ? "is-mobile-active" : ""
            }"
          >
            <persistent-world-invitation-card
              .snapshot=${snapshot}
              .shareUrl=${shareUrl}
              @world-share-status=${this.shareStatus}
              @world-share-failed=${this.copyShareFallback}
              @world-enter-runtime=${this.enterRuntimeFromCard}
              @world-dev-end=${this.endWorldForDevelopment}
            ></persistent-world-invitation-card>
            ${
              world.access === "private" &&
              !snapshot.viewer.isMember &&
              world.phase === "active"
                ? html`<button
                    class="pw-button pw-button--primary"
                    type="button"
                    @click=${() => this.requireIdentity("rsvp")}
                  >
                    Resume a nation
                  </button>`
                : nothing
            }
            ${
              isPendingRuntime
                ? html`<section
                    class="pw-runtime-state pw-runtime-state--pending"
                    role="status"
                  >
                    <span class="pw-runtime-state__orb" aria-hidden="true"
                      ><i></i
                    ></span>
                    <div>
                      <span
                        class="pw-eyebrow"
                        data-copy-slot="worlds.pendingEyebrow"
                        >${placeholderCopy.worlds.pendingEyebrow}</span
                      >
                      <h2 data-copy-slot="worlds.pendingHeading">
                        ${placeholderCopy.worlds.pendingHeading}
                      </h2>
                      <p data-copy-slot="worlds.pendingDescription">
                        ${placeholderCopy.worlds.pendingDescription}
                      </p>
                    </div>
                  </section>`
                : world.phase === "finished"
                  ? html`<section class="pw-runtime-state">
                      <span class="pw-runtime-state__orb" aria-hidden="true"
                        >✓</span
                      >
                      <div>
                        <span
                          class="pw-eyebrow"
                          data-copy-slot="worlds.finishedEyebrow"
                          >${placeholderCopy.worlds.finishedEyebrow}</span
                        >
                        <h2 data-copy-slot="worlds.finishedHeading">
                          ${placeholderCopy.worlds.finishedHeading}
                        </h2>
                        <p data-copy-slot="worlds.finishedDescription">
                          ${placeholderCopy.worlds.finishedDescription}
                        </p>
                      </div>
                    </section>`
                  : nothing
            }
            ${
              world.startMode !== "host"
                ? html`<persistent-world-reminder-picker
                    .options=${snapshot.reminderOptionsMs}
                    .selected=${snapshot.selectedReminderLeadTimesMs}
                    ?disabled=${!snapshot.viewer.isMember || this.submitting}
                    @world-reminders-change=${this.updateReminders}
                  ></persistent-world-reminder-picker>`
                : nothing
            }
          </div>
          <div
            class="pw-lobby__roster ${
              this.lobbyTab === "roster" ? "is-mobile-active" : ""
            }"
          >
            <persistent-world-roster
              .members=${snapshot.members}
              .maxHumans=${world.maxHumans}
              .mode=${world.mode}
            ></persistent-world-roster>
          </div>
          <div
            class="pw-lobby__chat ${
              this.lobbyTab === "chat" ? "is-mobile-active" : ""
            }"
          >
            <persistent-world-quick-chat
              .messages=${snapshot.quickChat}
              ?disabled=${!snapshot.viewer.canChat || this.submitting}
              @world-quick-chat=${this.postQuickChat}
            ></persistent-world-quick-chat>
          </div>
        </div>
        ${this.renderLobbyActionBar(snapshot)}
      </main>
    `;
  }

  private renderLobbyActionBar(snapshot: PersistentWorldLobbySnapshot) {
    const world = snapshot.world;
    if (this.confirmingLeave) {
      return html` <div
        class="pw-lobby-actions pw-lobby-actions--confirmation"
        role="alertdialog"
        aria-label="Leave world"
      >
        <div>
          <strong>Leave this world?</strong
          ><span>Your RSVP and reminder choices will be removed.</span>
        </div>
        <button
          class="pw-button pw-button--secondary"
          type="button"
          @click=${() => (this.confirmingLeave = false)}
        >
          Stay
        </button>
        <button
          class="pw-button pw-button--danger"
          type="button"
          @click=${this.leaveWorld}
        >
          Leave
        </button>
      </div>`;
    }
    if (snapshot.viewer.isMember) {
      return html` <div class="pw-lobby-actions">
        ${
          world.startMode === "host" && world.phase === "scheduled"
            ? snapshot.viewer.isHost
              ? html`<button
                  class="pw-button pw-button--primary"
                  type="button"
                  ?disabled=${this.submitting}
                  @click=${this.startCustomGame}
                >
                  ${this.submitting ? "Starting…" : "Start game"}
                </button>`
              : html`<span role="status">Waiting for the host to start</span>`
            : nothing
        }
        <div class="pw-lobby-actions__membership">
          <span class="pw-membership-check" aria-hidden="true">✓</span
          ><span
            ><strong>RSVP confirmed</strong
            ><small data-copy-slot="worlds.membershipDescription"
              >${placeholderCopy.worlds.membershipDescription}</small
            ></span
          >
        </div>
        ${
          snapshot.viewer.canCancel
            ? html`<button
                class="pw-text-button pw-text-button--danger"
                type="button"
                @click=${this.cancelWorld}
              >
                Cancel invitation
              </button>`
            : nothing
        }
        ${
          !snapshot.viewer.isHost && world.phase === "scheduled"
            ? html`<button
                class="pw-text-button"
                type="button"
                @click=${() => (this.confirmingLeave = true)}
              >
                Leave world
              </button>`
            : nothing
        }
      </div>`;
    }
    if (snapshot.viewer.canRsvp) {
      return html` <div class="pw-lobby-actions">
        <div>
          <span class="pw-eyebrow" data-copy-slot="worlds.invitationEyebrow"
            >${placeholderCopy.worlds.invitationEyebrow}</span
          ><strong data-copy-slot="worlds.invitationHeading"
            >${placeholderCopy.worlds.invitationHeading}</strong
          >
        </div>
        ${
          world.mode === "teams"
            ? html`<label class="pw-team-select"
                ><span>Team</span
                ><select
                  .value=${this.selectedTeam}
                  @change=${(event: Event) =>
                    (this.selectedTeam = (
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
        <button
          class="pw-button pw-button--primary"
          type="button"
          ?disabled=${this.submitting}
          @click=${this.rsvp}
        >
          ${this.submitting ? "Reserving…" : "Join this world"}
        </button>
      </div>`;
    }
    return html`<div class="pw-lobby-actions pw-lobby-actions--quiet">
      <div>
        <span class="pw-eyebrow">Viewing invitation</span
        ><strong
          >${
            world.phase === "scheduled"
              ? "The roster is full or unavailable."
              : "Late entry is closed."
          }</strong
        >
      </div>
    </div>`;
  }

  private renderLobbyLoading() {
    return html` <main
      class="pw-lobby pw-lobby--loading"
      aria-label="Opening invitation"
      aria-busy="true"
    >
      <div class="pw-lobby__composition">
        <div class="pw-skeleton pw-skeleton--invitation">
          <span></span><span></span><span></span><span></span>
        </div>
        <div class="pw-skeleton pw-skeleton--panel">
          <span></span><span></span><span></span>
        </div>
        <div class="pw-skeleton pw-skeleton--panel">
          <span></span><span></span><span></span>
        </div>
      </div>
      <div class="pw-loading-caption">
        <span>Opening lobby…</span>
      </div>
    </main>`;
  }

  private renderIdentity() {
    return html` <main class="pw-identity-screen">
      <button
        class="pw-icon-button pw-identity-screen__close"
        type="button"
        aria-label="Go back"
        @click=${() =>
          this.identityContinuation === "create"
            ? this.returnFromWizard()
            : this.restoreLobby()}
      >
        ×
      </button>
      <div class="pw-identity-screen__ambient" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <section class="pw-identity-card">
        <div class="pw-identity-card__crest" aria-hidden="true">
          <span>IF</span>
        </div>
        <span class="pw-eyebrow" data-copy-slot="worlds.identityEyebrow"
          >${placeholderCopy.worlds.identityEyebrow}</span
        >
        <h1 data-copy-slot="worlds.identityHeading">
          ${placeholderCopy.worlds.identityHeading}
        </h1>
        <p data-copy-slot="worlds.identityDescription">
          ${placeholderCopy.worlds.identityDescription}
        </p>
        <label class="pw-field"
          ><span>Display name</span
          ><input
            type="text"
            maxlength="80"
            autocomplete="nickname"
            enterkeyhint="done"
            .value=${this.identityName}
            @input=${(event: Event) =>
              (this.identityName = (
                event.currentTarget as HTMLInputElement
              ).value)}
            @keydown=${(event: KeyboardEvent) =>
              event.key === "Enter" && this.createIdentity()}
        /></label>
        ${
          this.identityContinuation === "rsvp"
            ? html`<label class="pw-field"
                ><span>Game password</span>
                <input
                  type="password"
                  autocomplete="current-password"
                  maxlength="128"
                  .value=${this.gamePassword}
                  @input=${(event: Event) => (this.gamePassword = (event.target as HTMLInputElement).value)}
                  @keydown=${(event: KeyboardEvent) => event.key === "Enter" && this.createIdentity()}
                />
                <small
                  >To resume your nation, use exactly the same username as on
                  your other device.</small
                >
              </label>`
            : nothing
        }
        ${
          this.error
            ? html`<div class="pw-alert" role="alert">${this.error}</div>`
            : nothing
        }
        <button
          class="pw-button pw-button--primary"
          type="button"
          ?disabled=${this.submitting || !this.identityName.trim()}
          @click=${this.createIdentity}
        >
          ${this.submitting ? "Sealing identity…" : "Continue"}
        </button>
        <small data-copy-slot="worlds.identityPrivacy"
          >${placeholderCopy.worlds.identityPrivacy}</small
        >
      </section>
    </main>`;
  }

  private renderError(heading: string, retry: () => void) {
    return html` <section class="pw-error-state" role="alert">
      <div class="pw-error-state__instrument" aria-hidden="true">
        <span>!</span><i></i>
      </div>
      <div>
        <span class="pw-eyebrow" data-copy-slot="worlds.errorEyebrow"
          >${placeholderCopy.worlds.errorEyebrow}</span
        >
        <h2>${heading}</h2>
        <p>${this.error || placeholderCopy.worlds.errorDescription}</p>
      </div>
      <button
        class="pw-button pw-button--secondary"
        type="button"
        @click=${retry}
      >
        Try again
      </button>
    </section>`;
  }

  private routeFromLocation() {
    const match = window.location.pathname.match(
      /^\/world\/([A-Za-z0-9_-]+)\/?$/,
    );
    if (match) {
      const worldId = match[1];
      this.view = "lobby";
      this.invitationSecret = consumeInvitationFragment(worldId);
      void this.loadLobby(worldId);
      return;
    }
    if (/^\/worlds\/new\/?$/.test(window.location.pathname)) {
      this.customGame =
        new URLSearchParams(window.location.search).get("kind") === "custom";
      void this.openWizardRoute();
      return;
    }
    this.view = "hub";
    void this.loadHub();
  }

  private async openWizardRoute() {
    this.loading = true;
    await this.resumeIdentity();
    this.loading = false;
    if (this.session) {
      this.error = "";
      this.view = "wizard";
    } else {
      this.requireIdentity("create");
    }
  }

  private loadHub = async () => {
    const sequence = ++this.loadSequence;
    this.stopPolling();
    this.loading = true;
    this.error = "";
    this.snapshot = null;
    await this.resumeIdentity();
    try {
      const [publicWorlds, myWorlds] = await Promise.all([
        persistentWorldApi.listPublic(),
        this.session ? persistentWorldApi.listMine() : Promise.resolve([]),
      ]);
      if (sequence !== this.loadSequence) return;
      this.publicWorlds = publicWorlds.filter((card) => !card.isViewerMember);
      this.myWorlds = myWorlds;
    } catch (error) {
      if (sequence !== this.loadSequence) return;
      this.error = this.errorMessage(error);
    } finally {
      if (sequence === this.loadSequence) this.loading = false;
    }
  };

  private async loadLobby(worldId: string, quiet = false) {
    const sequence = ++this.loadSequence;
    if (!quiet) this.loading = true;
    this.error = "";
    await this.resumeIdentity();
    try {
      const snapshot = await persistentWorldApi.getSnapshot(
        worldId,
        this.invitationSecret,
      );
      if (sequence !== this.loadSequence) return;
      if (
        this.snapshot?.world.id === worldId &&
        this.snapshot.world.phase === "scheduled" &&
        snapshot.world.phase === "active" &&
        snapshot.viewer.isMember
      ) {
        this.autoEnterWorldId = worldId;
      }
      this.snapshot = snapshot;
      this.loading = false;
      if (this.autoEnterWorldId === worldId && snapshot.runtimeGameId) {
        this.autoEnterWorldId = null;
        void this.enterRuntime(snapshot.runtimeGameId);
      }
    } catch (error) {
      if (sequence !== this.loadSequence) return;
      this.error = this.errorMessage(error);
      this.loading = false;
      if (
        error instanceof PersistentWorldApiError &&
        error.code === "INVITATION_REQUIRED"
      ) {
        this.requireIdentity("rsvp");
      }
    }
    if (
      sequence === this.loadSequence &&
      this.view === "lobby" &&
      (quiet || this.snapshot !== null)
    ) {
      this.startPolling(worldId);
    }
  }

  private refreshLobby = () => {
    const worldId =
      this.snapshot?.world.id ?? window.location.pathname.split("/")[2];
    if (worldId) void this.loadLobby(worldId, Boolean(this.snapshot));
  };

  private async resumeIdentity() {
    if (this.session || !persistentWorldApi.sessionToken()) return;
    try {
      const session = await persistentWorldApi.resumeSession();
      setGuestPlayToken(null);
      const guestPlayToken = await persistentWorldApi.bindGameIdentityWithToken(
        await getPlayToken(),
      );
      if (guestPlayToken !== null) setGuestPlayToken(guestPlayToken);
      this.session = session;
    } catch (error) {
      if (error instanceof PersistentWorldApiError && error.status === 401) {
        persistentWorldApi.forgetSession();
        this.session = null;
      }
    }
  }

  private beginCreate = () => {
    this.customGame = false;
    this.openCreateWizard();
  };

  private beginCustomGame = () => {
    this.customGame = true;
    this.openCreateWizard();
  };

  private openCreateWizard = () => {
    if (!this.session) return this.requireIdentity("create");
    this.error = "";
    this.wizardDeparting = false;
    this.view = "wizard";
    this.navigate(
      this.customGame ? "/worlds/new?kind=custom" : "/worlds/new",
      false,
    );
  };

  private startCustomGame = async () => {
    if (!this.snapshot || this.submitting) return;
    this.submitting = true;
    this.autoEnterWorldId = this.snapshot.world.id;
    try {
      this.snapshot = await persistentWorldApi.startCustomWorld(
        this.snapshot.world.id,
      );
      this.showNotice("Preparing the map…");
    } catch (error) {
      this.autoEnterWorldId = null;
      this.showNotice(this.errorMessage(error), "error");
    } finally {
      this.submitting = false;
    }
  };

  private createWorld = async (
    event: CustomEvent<{ input: CreatePersistentWorldRequest }>,
  ) => {
    this.submitting = true;
    this.error = "";
    try {
      const created = await persistentWorldApi.createWorld(event.detail.input);
      const worldId = created.snapshot.world.id;
      if (created.invitationSecret) {
        rememberInvitation(worldId, created.invitationSecret);
      }
      this.invitationSecret = created.invitationSecret;
      this.snapshot = created.snapshot;
      this.wizardDeparting = true;
      await new Promise<void>((resolve) =>
        window.setTimeout(
          resolve,
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? 60
            : 620,
        ),
      );
      this.view = "lobby";
      this.navigate(`/world/${worldId}`, false);
      this.startPolling(worldId);
      this.showNotice("Invitation created");
    } catch (error) {
      this.wizardDeparting = false;
      this.error = this.errorMessage(error);
    } finally {
      this.submitting = false;
    }
  };

  private openWorldEvent = (event: CustomEvent<{ worldId: string }>) => {
    this.openWorld(event.detail.worldId);
  };

  private openWorld(worldId: string) {
    this.snapshot = null;
    this.invitationSecret = invitationForWorld(worldId);
    this.view = "lobby";
    this.navigate(`/world/${worldId}`, false);
    void this.loadLobby(worldId);
  }

  private rsvp = () => {
    if (!this.session) return this.requireIdentity("rsvp");
    void this.completeRsvp();
  };

  private async completeRsvp() {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.submitting = true;
    this.error = "";
    try {
      this.snapshot = await persistentWorldApi.rsvp(
        snapshot.world.id,
        snapshot.world.mode === "teams" ? this.selectedTeam : null,
        this.invitationSecret,
      );
      this.showNotice("RSVP confirmed");
    } catch (error) {
      if (
        error instanceof PersistentWorldApiError &&
        (error.code === "WORLD_PASSWORD_REQUIRED" ||
          error.code === "USERNAME_TAKEN")
      ) {
        this.requireIdentity("rsvp");
        return;
      }
      this.showNotice(this.errorMessage(error), "error");
    } finally {
      this.submitting = false;
    }
  }

  private leaveWorld = async () => {
    const worldId = this.snapshot?.world.id;
    if (!worldId) return;
    this.submitting = true;
    try {
      await persistentWorldApi.leave(worldId);
      this.confirmingLeave = false;
      this.showHub();
    } catch (error) {
      this.showNotice(this.errorMessage(error), "error");
    } finally {
      this.submitting = false;
    }
  };

  private cancelWorld = async () => {
    const worldId = this.snapshot?.world.id;
    if (!worldId) return;
    this.submitting = true;
    try {
      this.snapshot = await persistentWorldApi.cancel(worldId);
      this.showNotice("Invitation cancelled", "warning");
    } catch (error) {
      this.showNotice(this.errorMessage(error), "error");
    } finally {
      this.submitting = false;
    }
  };

  // TODO(remove-after-playtests): temporary public dev control.
  private endWorldForDevelopment = async () => {
    const worldId = this.snapshot?.world.id;
    if (!worldId || this.submitting) return;
    if (!window.confirm("End this world for development testing?")) return;
    this.submitting = true;
    try {
      await persistentWorldApi.devEndWorld(worldId);
      await this.loadLobby(worldId, true);
      this.showNotice("World ended (development control)", "warning");
    } catch (error) {
      this.showNotice(this.errorMessage(error), "error");
    } finally {
      this.submitting = false;
    }
  };

  private postQuickChat = async (event: CustomEvent<{ phraseKey: string }>) => {
    const worldId = this.snapshot?.world.id;
    const chat = event.currentTarget as PersistentWorldQuickChat;
    if (!worldId) return chat.sendingComplete();
    try {
      await persistentWorldApi.postQuickChat(worldId, event.detail.phraseKey);
      await this.loadLobby(worldId, true);
    } catch (error) {
      this.showNotice(this.errorMessage(error), "error");
    } finally {
      chat.sendingComplete();
    }
  };

  private updateReminders = async (
    event: CustomEvent<{ leadTimesMs: number[] }>,
  ) => {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const previous = snapshot.selectedReminderLeadTimesMs;
    this.snapshot = {
      ...snapshot,
      selectedReminderLeadTimesMs: event.detail.leadTimesMs,
    };
    try {
      await persistentWorldApi.setReminders(
        snapshot.world.id,
        event.detail.leadTimesMs,
      );
      this.showNotice("Reminder choices saved");
    } catch (error) {
      this.snapshot = { ...snapshot, selectedReminderLeadTimesMs: previous };
      this.showNotice(this.errorMessage(error), "error");
    }
  };

  private async enterRuntime(runtimeGameId: string) {
    const worldId =
      this.snapshot?.runtimeGameId === runtimeGameId
        ? this.snapshot.world.id
        : null;
    if (worldId) {
      try {
        await persistentWorldApi.worldPlayToken(worldId);
        persistentWorldApi.rememberGameWorld(runtimeGameId, worldId);
      } catch (error) {
        if (!(
          error instanceof PersistentWorldApiError &&
          error.code === "ACCOUNT_SEAT"
        )) {
          this.showNotice(this.errorMessage(error), "error");
          return;
        }
      }
    }
    this.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: {
          gameID: runtimeGameId,
          source: "persistent-world",
        } as JoinLobbyEvent,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private enterRuntimeFromCard = (event: CustomEvent<{ gameId: string }>) => {
    this.enterRuntime(event.detail.gameId);
  };

  private requireIdentity(continuation: IdentityContinuation) {
    this.identityContinuation = continuation;
    this.identityName = this.suggestIdentityName();
    this.error = "";
    this.view = "identity";
  }

  private createIdentity = async () => {
    if (!this.identityName.trim()) return;
    this.submitting = true;
    this.error = "";
    try {
      // A new guest session must not reuse a credential issued to the prior
      // session on this device.
      setGuestPlayToken(null);
      const created =
        this.session?.identity.displayName === this.identityName.trim()
          ? { session: this.session }
          : await persistentWorldApi.createGuestSession(
              this.identityName.trim(),
            );
      const guestPlayToken = await persistentWorldApi.bindGameIdentityWithToken(
        await getPlayToken(),
      );
      if (guestPlayToken !== null) setGuestPlayToken(guestPlayToken);
      this.session = created.session;
      if (this.identityContinuation === "create") {
        this.view = "wizard";
        this.navigate(
          this.customGame ? "/worlds/new?kind=custom" : "/worlds/new",
          false,
        );
      } else {
        const worldId =
          this.snapshot?.world.id ?? window.location.pathname.split("/")[2];
        if (this.gamePassword) {
          await persistentWorldApi.unlockWorld(
            worldId,
            this.gamePassword,
            this.identityName.trim(),
          );
          this.gamePassword = "";
          this.snapshot = await persistentWorldApi.getSnapshot(
            worldId,
            this.invitationSecret,
          );
        }
        this.view = "lobby";
        await this.completeRsvp();
      }
    } catch (error) {
      this.error = this.errorMessage(error);
    } finally {
      this.submitting = false;
    }
  };

  private restoreLobby() {
    this.view = "lobby";
    this.error = "";
  }

  private suggestIdentityName(): string {
    const input = document.querySelector("username-input") as {
      getUsername?: () => string;
    } | null;
    return input?.getUsername?.() ?? "";
  }

  private showHub = (updateUrl = true) => {
    this.autoEnterWorldId = null;
    this.view = "hub";
    this.snapshot = null;
    this.stopPolling();
    if (updateUrl) this.navigate("/worlds", false);
    void this.loadHub();
  };

  private returnFromWizard = () => {
    this.wizardDeparting = false;
    history.replaceState(history.state, "", "/worlds");
    this.showHub(false);
  };

  private navigate(path: string, route = true) {
    history.pushState(history.state, "", path);
    if (path === "/") {
      window.showPage?.("page-play");
      return;
    }
    if (route) this.routeFromLocation();
  }

  private startPolling(worldId: string) {
    this.stopPolling();
    this.pollingWorldId = worldId;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      if (this.view !== "lobby" || this.pollingWorldId !== worldId) return;
      if (document.visibilityState === "visible") {
        void this.loadLobby(worldId, true);
      }
    }, LOBBY_POLL_INTERVAL_MS);
  }

  private stopPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.pollingWorldId = null;
  }

  private handleVisibilityChange = () => {
    if (document.visibilityState === "visible") this.refreshVisibleLobby();
  };

  private refreshVisibleLobby = () => {
    if (document.visibilityState !== "visible" || this.view !== "lobby") return;
    const worldId =
      this.pollingWorldId ??
      this.snapshot?.world.id ??
      window.location.pathname.split("/")[2];
    if (!worldId) return;
    this.stopPolling();
    void this.loadLobby(worldId, true);
  };

  private showNotice(message: string, tone: HeaderNoticeTone = "info") {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.notice = { message, tone };
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.noticeTimer = undefined;
    }, HEADER_NOTICE_DURATION_MS);
  }

  private copyShareFallback = async (event: CustomEvent<{ url: string }>) => {
    try {
      await navigator.clipboard.writeText(event.detail.url);
      this.showNotice("Invitation copied");
    } catch {
      this.showNotice("Copy the invitation from the address bar", "warning");
    }
  };

  private shareStatus = (event: CustomEvent<{ message: string }>) => {
    this.showNotice(event.detail.message);
  };

  private errorMessage(error: unknown): string {
    if (error instanceof PersistentWorldApiError) return error.message;
    if (error instanceof Error) return error.message;
    return "The world service did not answer.";
  }
}
