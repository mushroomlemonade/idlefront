import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./components/IOSAddToHomeScreenBanner";
import { placeholderCopy } from "./copy/PlaceholderCopy";
import { UsernameInput } from "./UsernameInput";

@customElement("game-mode-selector")
export class GameModeSelector extends LitElement {
  @state() private inputValid = true;
  @state() private signingIn = false;
  @state() private signInError = "";

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(
      "username-validity-change",
      this.handleValidityChange,
    );

    const usernameInput = document.querySelector(
      "username-input",
    ) as UsernameInput | null;
    if (usernameInput) this.inputValid = usernameInput.canPlay();
  }

  disconnectedCallback() {
    this.stop();
    window.removeEventListener(
      "username-validity-change",
      this.handleValidityChange,
    );
    super.disconnectedCallback();
  }

  public stop() {
    // Kept for the existing Client lifecycle. The standalone IdleFront launch
    // surface no longer owns an ordinary public-lobby socket.
  }

  private handleValidityChange = (event: Event) => {
    this.inputValid = (event as CustomEvent).detail?.isValid ?? true;
  };

  render() {
    const disabled = !this.inputValid || this.signingIn;

    return html`
      <div class="atlas-game-modes">
        ${this.signInError ? html`<p role="alert">${this.signInError}</p>` : null}
        <ios-add-to-home-screen-banner
          class="atlas-install-prompt no-crazygames"
        ></ios-add-to-home-screen-banner>

        <button
          type="button"
          class="atlas-quick-play ${disabled ? "is-disabled" : ""}"
          ?disabled=${disabled}
          @click=${this.openWorlds}
          data-haptic="medium"
        >
          <span class="atlas-quick-play__icon" aria-hidden="true"
            ><svg
              viewBox="0 0 24 24"
              width="24"
              height="24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <path d="M8 5 19 12 8 19Z" /></svg
          ></span>
          <span class="atlas-quick-play__copy">
            <strong data-copy-slot="landing.primaryAction"
              >${placeholderCopy.landing.primaryAction}</strong
            >
            <small data-copy-slot="landing.primaryActionDetail"
              >${placeholderCopy.landing.primaryActionDetail}</small
            >
          </span>
          <svg
            class="atlas-quick-play__chevron"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="m7.5 4.5 5 5.5-5 5.5"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    `;
  }

  private validateUsername(): boolean {
    const usernameInput = document.querySelector(
      "username-input",
    ) as UsernameInput | null;
    return usernameInput ? usernameInput.canPlay() : true;
  }

  private openWorlds = async () => {
    if (!this.validateUsername() || this.signingIn) return;
    this.signingIn = true;
    this.signInError = "";
    try {
      const page = document.querySelector<PersistentWorldPageElement>(
        "persistent-world-page",
      );
      const name = document
        .querySelector<UsernameInput>("username-input")
        ?.getUsername();
      if (!page?.signIn || !name)
        throw new Error("Please enter your username.");
      await page.signIn(name);

      history.pushState(history.state, "", "/worlds");
      window.showPage?.("page-persistent-worlds");
      document
        .querySelector<PersistentWorldPageElement>("persistent-world-page")
        ?.open?.();
    } catch (error) {
      this.signInError =
        error instanceof Error
          ? error.message
          : "Unable to sign in. Please try again.";
    } finally {
      this.signingIn = false;
    }
  };
}

interface PersistentWorldPageElement extends Element {
  signIn?: (name: string) => Promise<void>;
  open?: () => void;
}
