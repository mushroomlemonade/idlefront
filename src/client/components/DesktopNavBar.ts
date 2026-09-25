import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import "./AtlasPrimitives";
import "./ProductWordmark";

@customElement("desktop-nav-bar")
export class DesktopNavBar extends LitElement {
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("showPage", this._onShowPage);

    const current = window.currentPageId;
    if (current) {
      // Wait for render
      this.updateComplete.then(() => {
        this._updateActiveState(current);
      });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("showPage", this._onShowPage);
  }

  private _onShowPage = (e: Event) => {
    const pageId = (e as CustomEvent).detail;
    this._updateActiveState(pageId);
  };

  private _updateActiveState(pageId: string) {
    this.querySelectorAll(".nav-menu-item").forEach((el) => {
      if ((el as HTMLElement).dataset.page === pageId) {
        el.classList.add("active");
      } else {
        el.classList.remove("active");
      }
    });
  }

  render() {
    window.currentPageId ??= "page-play";
    const currentPage = window.currentPageId;

    return html`
      <nav
        class="atlas-desktop-nav hidden lg:flex w-full items-center shrink-0 z-50 relative"
      >
        <div class="atlas-desktop-nav__brand">
          <product-wordmark compact></product-wordmark>
          <div id="game-version" class="atlas-version"></div>
        </div>
        <div class="atlas-desktop-nav__links">
          <atlas-status-lamp
            label="World online"
            i18n-key="pressure_atlas.world_online"
          ></atlas-status-lamp>
          <atlas-nav-item
            compact
            page="page-play"
            i18n-key="main.play"
            label="Play"
            ?active=${currentPage === "page-play"}
          ></atlas-nav-item>
          <button
            id="nav-account-button"
            class="atlas-account-button nav-menu-item relative overflow-hidden flex items-center justify-center gap-2"
            data-page="page-account"
            data-i18n-aria-label="main.account"
            data-i18n-title="main.account"
          >
            <img
              id="nav-account-avatar"
              class="hidden w-8 h-8 rounded-full object-cover"
              alt=""
              data-i18n-alt="main.discord_avatar_alt"
              referrerpolicy="no-referrer"
            />
            <span
              id="nav-account-loading-spinner"
              class="w-4 h-4 border-2 border-white/30 border-t-white/80 rounded-full animate-spin"
              aria-hidden="true"
            ></span>
            <svg
              id="nav-account-person-icon"
              class="hidden w-5 h-5"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M20 21a8 8 0 0 0-16 0" />
              <path d="M12 13a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z" />
            </svg>
            <span
              id="nav-account-email-badge"
              class="hidden absolute bottom-1 right-1 w-4 h-4 rounded-full bg-slate-900/80 border border-white/20 flex items-center justify-center"
              aria-hidden="true"
            >
              <svg
                class="w-2.5 h-2.5 text-white/80"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M4 4h16v16H4z" opacity="0" />
                <path d="M4 6h16v12H4z" />
                <path d="m4 7 8 6 8-6" />
              </svg>
            </span>
            <span
              id="nav-account-signin-text"
              class="hidden text-xs font-bold tracking-widest"
              data-i18n="main.sign_in"
            >
            </span>
          </button>
          <button
            id="desktop-menu-button"
            class="atlas-menu-trigger"
            type="button"
            aria-controls="sidebar-menu"
            aria-expanded="false"
            data-i18n-aria-label="main.menu"
            data-i18n-title="main.menu"
          >
            <span aria-hidden="true"></span>
            <span data-i18n="main.menu">Menu</span>
          </button>
        </div>
      </nav>
    `;
  }
}
