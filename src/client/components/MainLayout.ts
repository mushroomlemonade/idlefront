import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";

@customElement("main-layout")
export class MainLayout extends LitElement {
  private _initialChildren: Node[] = [];

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    if (this._initialChildren.length === 0 && this.childNodes.length > 0) {
      this._initialChildren = Array.from(this.childNodes);
    }
    super.connectedCallback();
  }

  render() {
    return html`
      <main
        class="atlas-main-layout relative [.in-game_&]:hidden flex flex-col flex-1 overflow-hidden w-full px-0"
      >
        <div
          class="atlas-main-scroll w-full max-w-[1440px] mx-auto flex flex-col flex-1 overflow-hidden"
        >
          ${this._initialChildren}
        </div>
      </main>
    `;
  }
}
