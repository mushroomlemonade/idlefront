import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "../../../client/Utils";
import { assetUrl } from "../../../core/AssetUrls";
import { EventBus } from "../../../core/EventBus";
import {
  BuildableUnit,
  BuildMenus,
  Gold,
  PlayerBuildableUnitType,
  UnitType,
} from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { Controller } from "../../Controller";
import {
  CloseViewEvent,
  MouseDownEvent,
  ShowBuildMenuEvent,
  ShowEmojiMenuEvent,
} from "../../InputHandler";
import { startStructureDrag } from "../../StructureDrag";
import { TransformHandler } from "../../TransformHandler";
import {
  BuildUnitIntentEvent,
  SendUpgradeStructureIntentEvent,
} from "../../Transport";
import { UIState } from "../../UIState";
import { renderNumber } from "../../Utils";
import { GameView } from "../../view";
const warshipIcon = assetUrl("images/BattleshipIconWhite.svg");
const cityIcon = assetUrl("images/CityIconWhite.svg");
const factoryIcon = assetUrl("images/FactoryIconWhite.svg");
const goldCoinIcon = assetUrl("images/GoldCoinIcon.svg");
const mirvIcon = assetUrl("images/MIRVIcon.svg");
const missileSiloIcon = assetUrl("images/MissileSiloIconWhite.svg");
const hydrogenBombIcon = assetUrl("images/MushroomCloudIconWhite.svg");
const atomBombIcon = assetUrl("images/NukeIconWhite.svg");
const portIcon = assetUrl("images/PortIcon.svg");
const samlauncherIcon = assetUrl("images/SamLauncherIconWhite.svg");
const shieldIcon = assetUrl("images/ShieldIconWhite.svg");

export interface BuildItemDisplay {
  unitType: PlayerBuildableUnitType;
  icon: string;
  description?: string;
  key?: string;
  countable?: boolean;
}

export const buildTable: BuildItemDisplay[][] = [
  [
    {
      unitType: UnitType.AtomBomb,
      icon: atomBombIcon,
      description: "build_menu.desc.atom_bomb",
      key: "unit_type.atom_bomb",
      countable: false,
    },
    {
      unitType: UnitType.MIRV,
      icon: mirvIcon,
      description: "build_menu.desc.mirv",
      key: "unit_type.mirv",
      countable: false,
    },
    {
      unitType: UnitType.HydrogenBomb,
      icon: hydrogenBombIcon,
      description: "build_menu.desc.hydrogen_bomb",
      key: "unit_type.hydrogen_bomb",
      countable: false,
    },
    {
      unitType: UnitType.Warship,
      icon: warshipIcon,
      description: "build_menu.desc.warship",
      key: "unit_type.warship",
      countable: true,
    },
    {
      unitType: UnitType.Port,
      icon: portIcon,
      description: "build_menu.desc.port",
      key: "unit_type.port",
      countable: true,
    },
    {
      unitType: UnitType.MissileSilo,
      icon: missileSiloIcon,
      description: "build_menu.desc.missile_silo",
      key: "unit_type.missile_silo",
      countable: true,
    },
    {
      unitType: UnitType.SAMLauncher,
      icon: samlauncherIcon,
      description: "build_menu.desc.sam_launcher",
      key: "unit_type.sam_launcher",
      countable: true,
    },
    {
      unitType: UnitType.DefensePost,
      icon: shieldIcon,
      description: "build_menu.desc.defense_post",
      key: "unit_type.defense_post",
      countable: true,
    },
    {
      unitType: UnitType.City,
      icon: cityIcon,
      description: "build_menu.desc.city",
      key: "unit_type.city",
      countable: true,
    },
    {
      unitType: UnitType.Factory,
      icon: factoryIcon,
      description: "build_menu.desc.factory",
      key: "unit_type.factory",
      countable: true,
    },
  ],
];

export const flattenedBuildTable = buildTable.flat();

@customElement("build-menu")
export class BuildMenu extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public uiState: UIState;
  private clickedTile: TileRef;
  public playerBuildables: BuildableUnit[] | null = null;
  private filteredBuildTable: BuildItemDisplay[][] = buildTable;
  public transformHandler: TransformHandler;

  init() {
    this.eventBus.on(ShowBuildMenuEvent, (e) => {
      if (!this.game.myPlayer()?.isAlive()) {
        return;
      }
      if (!this._hidden) {
        // Players sometimes hold control while building a unit,
        // so if the menu is already open, ignore the event.
        return;
      }
      const clickedCell = this.transformHandler.screenToWorldCoordinates(
        e.x,
        e.y,
      );
      if (!this.game.isValidCoord(clickedCell.x, clickedCell.y)) {
        return;
      }
      const tile = this.game.ref(clickedCell.x, clickedCell.y);
      this.showMenu(tile);
    });
    this.eventBus.on(CloseViewEvent, () => this.hideMenu());
    this.eventBus.on(ShowEmojiMenuEvent, () => this.hideMenu());
    this.eventBus.on(MouseDownEvent, () => this.hideMenu());
  }

  tick() {
    if (!this._hidden) {
      this.refresh();
    }
  }

  static styles = css`
    :host {
      display: block;
    }
    .build-menu {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 9999;
      border: 3px solid #a47529;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.12), transparent 23%),
        url("/resources/images/ui/materials/mahogany@2x.webp"), #210c08;
      background-size:
        auto,
        384px 384px,
        auto;
      padding: 18px;
      box-shadow:
        0 30px 90px rgba(0, 0, 0, 0.72),
        inset 0 0 0 1px rgba(255, 230, 157, 0.24),
        inset 0 0 34px rgba(0, 0, 0, 0.5);
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      max-width: 95vw;
      max-height: 95vh;
      overflow-y: auto;
    }
    .build-description {
      font-size: 0.6rem;
    }
    .build-row {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      width: 100%;
    }
    .build-button {
      position: relative;
      width: 120px;
      height: 140px;
      overflow: hidden;
      border: 2px solid #7a5118;
      background:
        radial-gradient(
          circle at 50% 120%,
          rgba(78, 176, 142, 0.2),
          transparent 58%
        ),
        linear-gradient(155deg, rgba(255, 255, 255, 0.13), transparent 24%),
        #071713;
      color: #fff3cd;
      border-radius: 11px;
      cursor: pointer;
      box-shadow:
        inset 0 3px 13px rgba(0, 0, 0, 0.72),
        inset 0 1px rgba(255, 255, 255, 0.17),
        0 5px 12px rgba(0, 0, 0, 0.42);
      transition:
        transform 130ms cubic-bezier(0.2, 0.72, 0.2, 1),
        border-color 130ms ease,
        filter 130ms ease;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      margin: 8px;
      padding: 10px;
      gap: 5px;
    }
    .build-button:not(:disabled):hover {
      filter: brightness(1.14);
      transform: translateY(-2px) scale(1.018);
      border-color: #f5cf70;
    }
    .build-button:not(:disabled):active {
      filter: brightness(0.88);
      transform: translateY(1px) scale(0.985);
    }
    .build-button:disabled {
      background-color: #0b0c0b;
      border-color: #3c2d17;
      cursor: not-allowed;
      opacity: 0.7;
    }
    .build-button:disabled img {
      opacity: 0.5;
    }
    .build-button:disabled .build-cost {
      color: #ff4444;
    }
    .build-icon {
      font-size: 40px;
      margin-bottom: 5px;
    }
    .build-name {
      font-size: 14px;
      font-weight: bold;
      margin-bottom: 5px;
      text-align: center;
    }
    .build-cost {
      font-size: 14px;
    }
    .hidden {
      display: none !important;
    }
    .build-count-chip {
      position: absolute;
      top: -10px;
      right: -10px;
      background: linear-gradient(
        180deg,
        #fff0a9,
        #c18b32 48%,
        #6f430d 52%,
        #b57c24
      );
      color: #251503;
      padding: 2px 10px;
      border-radius: 10000px;
      transition: all 0.3s ease;
      font-size: 12px;
      display: flex;
      justify-content: center;
      align-content: center;
      border: 1px solid #f2cf72;
      text-shadow: 0 1px rgba(255, 255, 255, 0.5);
      box-shadow: 0 3px 8px rgba(0, 0, 0, 0.52);
    }
    .build-button:not(:disabled):hover > .build-count-chip {
      filter: brightness(1.08);
      border-color: #fff1b3;
    }
    .build-button:not(:disabled):active > .build-count-chip {
      filter: brightness(0.9);
    }
    .build-button:disabled > .build-count-chip {
      background: #30271b;
      border-color: #4c3a22;
      cursor: not-allowed;
    }
    .build-count {
      font-weight: bold;
      font-size: 14px;
    }

    .build-button::before {
      position: absolute;
      inset: 1px 2px 58%;
      border-radius: 8px 8px 45% 45%;
      background: linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.14),
        transparent
      );
      content: "";
      pointer-events: none;
    }

    .build-button img {
      position: relative;
      z-index: 1;
      filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.72));
    }

    .build-name {
      color: #fff0b8;
      text-shadow: 0 -1px rgba(0, 0, 0, 0.8);
    }

    .build-description {
      color: #cdbd91;
      line-height: 1.25;
    }

    .build-cost {
      color: #f2d176;
      font-variant-numeric: tabular-nums;
      text-shadow: 0 -1px rgba(0, 0, 0, 0.7);
    }

    @media (prefers-reduced-motion: reduce) {
      .build-button,
      .build-count-chip {
        transition: none;
      }
    }

    @media (max-width: 768px) {
      .build-menu {
        padding: 10px;
        max-height: 80vh;
        width: 80vw;
      }
      .build-button {
        width: 140px;
        height: 120px;
        margin: 4px;
        padding: 6px;
        gap: 5px;
      }
      .build-icon {
        font-size: 28px;
      }
      .build-name {
        font-size: 12px;
        margin-bottom: 3px;
      }
      .build-cost {
        font-size: 11px;
      }
      .build-count {
        font-weight: bold;
        font-size: 10px;
      }
      .build-count-chip {
        padding: 1px 5px;
      }
    }

    @media (max-width: 480px) {
      .build-menu {
        padding: 8px;
        max-height: 70vh;
      }
      .build-button {
        width: calc(50% - 6px);
        height: 100px;
        margin: 3px;
        padding: 4px;
        border-width: 1px;
      }
      .build-icon {
        font-size: 24px;
      }
      .build-name {
        font-size: 10px;
        margin-bottom: 2px;
      }
      .build-cost {
        font-size: 9px;
      }
      .build-count {
        font-weight: bold;
        font-size: 8px;
      }
      .build-count-chip {
        padding: 0 3px;
      }
      .build-button img {
        width: 24px;
        height: 24px;
      }
      .build-cost img {
        width: 10px;
        height: 10px;
      }
    }
  `;

  @state()
  private _hidden = true;

  public canBuildOrUpgrade(item: BuildItemDisplay): boolean {
    if (this.game?.myPlayer() === null || this.playerBuildables === null) {
      return false;
    }
    const unit = this.playerBuildables.find((u) => u.type === item.unitType);
    return unit ? unit.canBuild !== false || unit.canUpgrade !== false : false;
  }

  public cost(item: BuildItemDisplay): Gold {
    for (const bu of this.playerBuildables ?? []) {
      if (bu.type === item.unitType) {
        return bu.cost;
      }
    }
    return 0n;
  }

  public count(item: BuildItemDisplay): string {
    const player = this.game?.myPlayer();
    if (!player) {
      return "?";
    }

    return player.totalUnitLevels(item.unitType).toString();
  }

  public sendBuildOrUpgrade(buildableUnit: BuildableUnit, tile: TileRef): void {
    if (buildableUnit.canUpgrade !== false) {
      this.eventBus.emit(
        new SendUpgradeStructureIntentEvent(
          buildableUnit.canUpgrade,
          buildableUnit.type,
        ),
      );
    } else if (buildableUnit.canBuild) {
      const rocketDirectionUp =
        buildableUnit.type === UnitType.AtomBomb ||
        buildableUnit.type === UnitType.HydrogenBomb
          ? this.uiState.rocketDirectionUp
          : undefined;
      this.eventBus.emit(
        new BuildUnitIntentEvent(buildableUnit.type, tile, rocketDirectionUp),
      );
    }
    this.hideMenu();
  }

  render() {
    return html`
      <div
        class="build-menu ${this._hidden ? "hidden" : ""}"
        @contextmenu=${(e: MouseEvent) => e.preventDefault()}
      >
        ${this.filteredBuildTable.map(
          (row) => html`
            <div class="build-row">
              ${row.map((item) => {
                const buildableUnit = this.playerBuildables?.find(
                  (bu) => bu.type === item.unitType,
                );
                if (buildableUnit === undefined) {
                  return html``;
                }
                const enabled =
                  buildableUnit.canBuild !== false ||
                  buildableUnit.canUpgrade !== false;
                const nuclearAction =
                  item.unitType === UnitType.AtomBomb ||
                  item.unitType === UnitType.HydrogenBomb ||
                  item.unitType === UnitType.MIRV;
                return html`
                  <button
                    class="build-button"
                    data-haptic=${nuclearAction ? "nuke" : "selection"}
                    style="touch-action:none"
                    @pointerdown=${(event: PointerEvent) => startStructureDrag(event, item.unitType, this.eventBus, () => this.hideMenu())}
                    @click=${() =>
                      this.sendBuildOrUpgrade(buildableUnit, this.clickedTile)}
                    ?disabled=${!enabled}
                    title=${
                      !enabled
                        ? translateText("build_menu.not_enough_money")
                        : ""
                    }
                  >
                    <img
                      src=${item.icon}
                      alt="${item.unitType}"
                      width="40"
                      height="40"
                    />
                    <span class="build-name"
                      >${item.key && translateText(item.key)}</span
                    >
                    <span class="build-description"
                      >${
                        item.description && translateText(item.description)
                      }</span
                    >
                    <span class="build-cost" translate="no">
                      ${renderNumber(
                        this.game && this.game.myPlayer() ? this.cost(item) : 0,
                      )}
                      <img
                        src=${goldCoinIcon}
                        alt="gold"
                        width="12"
                        height="12"
                        class="align-middle"
                      />
                    </span>
                    ${
                      item.countable
                        ? html`<div class="build-count-chip">
                            <span class="build-count">${this.count(item)}</span>
                          </div>`
                        : ""
                    }
                  </button>
                `;
              })}
            </div>
          `,
        )}
      </div>
    `;
  }

  hideMenu() {
    this._hidden = true;
    this.requestUpdate();
  }

  showMenu(clickedTile: TileRef) {
    this.clickedTile = clickedTile;
    this._hidden = false;
    this.refresh();
  }

  private refresh() {
    this.game
      .myPlayer()
      ?.buildables(this.clickedTile, BuildMenus.types)
      .then((buildables) => {
        this.playerBuildables = buildables;
        this.requestUpdate();
      });

    // remove disabled buildings from the buildtable
    this.filteredBuildTable = this.getBuildableUnits();
  }

  private getBuildableUnits(): BuildItemDisplay[][] {
    return buildTable.map((row) =>
      row.filter((item) => !this.game?.config()?.isUnitDisabled(item.unitType)),
    );
  }

  get isVisible() {
    return !this._hidden;
  }
}
