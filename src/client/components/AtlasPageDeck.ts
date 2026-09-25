import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import "./LegalNoticePage";
import "./persistent-world/PersistentWorldPage";

const pageClass =
  "atlas-page-stage hidden w-full h-full page-content relative z-50";

/**
 * Owns the non-game destinations mounted inside the title-screen stage.
 * Navigation still targets the canonical page IDs and original components.
 */
@customElement("atlas-page-deck")
export class AtlasPageDeck extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <matchmaking-modal
        id="page-matchmaking"
        inline
        class=${pageClass}
      ></matchmaking-modal>
      <news-modal id="page-news" inline class=${pageClass}></news-modal>
      <single-player-modal
        id="page-single-player"
        inline
        class=${pageClass}
      ></single-player-modal>
      <host-lobby-modal
        id="page-host-lobby"
        inline
        class=${pageClass}
      ></host-lobby-modal>
      <join-lobby-modal
        id="page-join-lobby"
        inline
        class=${pageClass}
      ></join-lobby-modal>
      <store-modal id="page-item-store" inline class=${pageClass}></store-modal>
      <user-setting id="page-settings" inline class=${pageClass}></user-setting>
      <leaderboard-modal
        id="page-leaderboard"
        inline
        class=${pageClass}
      ></leaderboard-modal>
      <troubleshooting-modal
        id="page-troubleshooting"
        inline
        class=${pageClass}
      ></troubleshooting-modal>
      <clan-modal id="page-clan" inline class=${pageClass}></clan-modal>
      <account-modal
        id="page-account"
        inline
        class=${pageClass}
      ></account-modal>
      <game-stats-modal
        id="page-stats"
        inline
        class=${pageClass}
      ></game-stats-modal>
      <player-profile-modal
        id="page-profile"
        inline
        class=${pageClass}
      ></player-profile-modal>
      <help-modal id="page-help" inline class=${pageClass}></help-modal>
      <language-modal
        id="page-language"
        inline
        class=${pageClass}
      ></language-modal>
      <inventory-modal
        id="page-inventory"
        inline
        class=${pageClass}
      ></inventory-modal>
      <ranked-modal id="page-ranked" inline class=${pageClass}></ranked-modal>
      <legal-notice-page id="page-legal" class=${pageClass}></legal-notice-page>
      <persistent-world-page
        id="page-persistent-worlds"
        class=${pageClass}
      ></persistent-world-page>
    `;
  }
}
