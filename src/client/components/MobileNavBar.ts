import { html, LitElement, TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import "./AtlasPrimitives";
import { NavNotificationsController } from "./NavNotificationsController";
import "./ProductWordmark";

@customElement("mobile-nav-bar")
export class MobileNavBar extends LitElement {
  private _notifications = new NavNotificationsController(this);

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("showPage", this._onShowPage);

    const current = window.currentPageId;
    if (current) {
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
      const inner = el.querySelector("button");
      if ((el as HTMLElement).dataset.page === pageId) {
        el.classList.add("active");
        inner?.classList.add("active");
      } else {
        el.classList.remove("active");
        inner?.classList.remove("active");
      }
    });
  }

  private _renderItem(
    page: string,
    i18nKey: string,
    label: string,
    currentPage: string,
    options: {
      attention?: "none" | "info" | "danger";
      className?: string;
      onClick?: () => void;
    } = {},
  ): TemplateResult {
    return html`<atlas-nav-item
      class=${options.className ?? ""}
      page=${page}
      i18n-key=${i18nKey}
      label=${label}
      attention=${options.attention ?? "none"}
      ?active=${currentPage === page}
      @click=${options.onClick}
    ></atlas-nav-item>`;
  }

  render() {
    window.currentPageId ??= "page-play";
    const currentPage = window.currentPageId;

    return html`
      <div class="atlas-navigation-drawer">
        <div class="atlas-mobile-nav__brand">
          <product-wordmark></product-wordmark>
          <div id="game-version" class="atlas-version"></div>
          <atlas-status-lamp
            label="World online"
            i18n-key="pressure_atlas.world_online"
          ></atlas-status-lamp>
        </div>

        <nav class="atlas-navigation-drawer__items" aria-label="Game menu">
          ${this._renderItem("page-play", "main.play", "Play", currentPage)}
          ${this._renderItem(
            "page-item-store",
            "main.store",
            "Store",
            currentPage,
            {
              attention: this._notifications.showStoreDot() ? "danger" : "none",
              className: "no-crazygames",
              onClick: this._notifications.onStoreClick,
            },
          )}
          ${this._renderItem(
            "page-inventory",
            "main.inventory",
            "Inventory",
            currentPage,
          )}
          ${this._renderItem(
            "page-ranked",
            "mode_selector.ranked_title",
            "Ranked",
            currentPage,
          )}
          ${this._renderItem(
            "page-leaderboard",
            "main.leaderboard",
            "Leaderboard",
            currentPage,
          )}
          ${this._renderItem("page-clan", "main.clans", "Clans", currentPage, {
            className: "no-crazygames",
          })}
          ${this._renderItem(
            "page-settings",
            "main.settings",
            "Settings",
            currentPage,
          )}
          ${this._renderItem(
            "page-account",
            "main.account",
            "Account",
            currentPage,
          )}
          ${this._renderItem("page-help", "main.help", "Help", currentPage, {
            attention: this._notifications.showHelpDot() ? "info" : "none",
            onClick: this._notifications.onHelpClick,
          })}
        </nav>

        <footer class="atlas-navigation-drawer__footer">
          <lang-selector></lang-selector>
          <button
            type="button"
            class="atlas-legal-trigger nav-menu-item"
            data-page="page-legal"
          >
            <span>Licenses, credits &amp; attribution</span>
            <strong>Legal + source</strong>
          </button>
          <small class="atlas-legal-credit">© OpenFront and Contributors</small>
        </footer>
      </div>
    `;
  }
}
