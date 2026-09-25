import { assetUrl } from "../../../core/AssetUrls";
import { EventBus } from "../../../core/EventBus";
import { PlayerActions, UnitType } from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { Controller } from "../../Controller";
import { StructureDragEvent } from "../../StructureDrag";
import { TransformHandler } from "../../TransformHandler";
import { UIState } from "../../UIState";
import { GameView, PlayerView } from "../../view";
import { BuildMenu } from "./BuildMenu";
import { ChatIntegration } from "./ChatIntegration";
import { EmojiTable } from "./EmojiTable";
import { PlayerActionHandler } from "./PlayerActionHandler";
import { PlayerPanel } from "./PlayerPanel";
import { RadialMenu, RadialMenuConfig } from "./RadialMenu";
import {
  attackMenuElement,
  centerButtonElement,
  COLORS,
  MenuElementParams,
  rootMenuElement,
} from "./RadialMenuElements";
const donateTroopIcon = assetUrl("images/DonateTroopIconWhite.svg");
const swordIcon = assetUrl("images/SwordIconWhite.svg");

import { ContextMenuEvent } from "../../InputHandler";

export class MainRadialMenu implements Controller {
  private radialMenu: RadialMenu;
  private placementMenu: RadialMenu;
  private placementType: UnitType | null = null;

  private playerActionHandler: PlayerActionHandler;
  private chatIntegration: ChatIntegration;

  private clickedTile: TileRef | null = null;

  getTickIntervalMs() {
    return 500;
  }

  constructor(
    private eventBus: EventBus,
    private game: GameView,
    private transformHandler: TransformHandler,
    private emojiTable: EmojiTable,
    private buildMenu: BuildMenu,
    private uiState: UIState,
    private playerPanel: PlayerPanel,
  ) {
    const menuConfig: RadialMenuConfig = {
      centerButtonIcon: swordIcon,
      tooltipStyle: `
        .radial-tooltip .cost {
          margin-top: 4px;
          color: ${COLORS.tooltip.cost};
        }
        .radial-tooltip .count {
          color: ${COLORS.tooltip.count};
        }
      `,
    };

    this.radialMenu = new RadialMenu(
      this.eventBus,
      rootMenuElement,
      centerButtonElement,
      menuConfig,
    );
    this.placementMenu = new RadialMenu(
      this.eventBus,
      {
        id: "placement-confirm",
        name: "Confirm placement",
        disabled: () => false,
        subMenu: (params) => {
          const item = attackMenuElement
            .subMenu?.(params)
            .find((item) => item.id === `attack_${this.placementType}`);
          if (!item)
            return [
              {
                id: "cancel",
                name: "Cancel",
                text: "×",
                disabled: () => false,
                action: () => this.placementMenu.hideRadialMenu(),
              },
            ];
          return [
            {
              ...item,
              id: "confirm",
              name: "Confirm",
              icon: undefined,
              text: "✓",
              subMenu: undefined,
            },
            {
              id: "cancel",
              name: "Cancel",
              text: "×",
              disabled: () => false,
              action: () => this.placementMenu.hideRadialMenu(),
            },
            ...(item.subMenu?.(params) ?? []),
          ];
        },
      },
      {
        disabled: () => false,
        action: () => this.placementMenu.hideRadialMenu(),
      },
      { centerButtonIcon: assetUrl("images/BackIconWhite.svg") },
    );

    this.playerActionHandler = new PlayerActionHandler(
      this.eventBus,
      this.uiState,
    );

    this.chatIntegration = new ChatIntegration(this.game, this.eventBus);
  }

  init() {
    this.radialMenu.init();
    this.placementMenu.init();
    this.eventBus.on(StructureDragEvent, async (event) => {
      if (
        event.phase !== "drop" ||
        ![UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV].includes(
          event.type,
        )
      )
        return;
      const world = this.transformHandler.screenToWorldCoordinates(
        event.x,
        event.y,
      );
      const player = this.game.myPlayer();
      if (!player || !this.game.isValidCoord(world.x, world.y)) return;
      const tile = this.game.ref(world.x, world.y);
      const actions = await player.actions(tile);
      this.placementType = event.type;
      await this.updatePlayerActions(
        player,
        actions,
        tile,
        event.x,
        event.y,
        true,
      );
    });
    this.eventBus.on(ContextMenuEvent, (event) => {
      const worldCoords = this.transformHandler.screenToWorldCoordinates(
        event.x,
        event.y,
      );
      if (!this.game.isValidCoord(worldCoords.x, worldCoords.y)) {
        return;
      }
      if (this.game.myPlayer() === null) {
        return;
      }
      this.clickedTile = this.game.resolveFogTap(
        this.game.ref(worldCoords.x, worldCoords.y),
      );
      if (this.clickedTile === null) return;
      const selectedTile = this.clickedTile;
      this.game
        .myPlayer()!
        .actions(selectedTile)
        .then((actions) => {
          this.updatePlayerActions(
            this.game.myPlayer()!,
            actions,
            selectedTile,
            event.x,
            event.y,
          );
        });
    });
  }

  private async updatePlayerActions(
    myPlayer: PlayerView,
    actions: PlayerActions,
    tile: TileRef,
    screenX: number | null = null,
    screenY: number | null = null,
    placement = false,
  ) {
    this.buildMenu.playerBuildables = actions.buildableUnits;

    const tileOwner = this.game.owner(tile);
    const recipient = tileOwner.isPlayer() ? (tileOwner as PlayerView) : null;

    if (myPlayer && recipient) {
      this.chatIntegration.setupChatModal(myPlayer, recipient);
    }

    const params: MenuElementParams = {
      myPlayer,
      selected: recipient,
      tile,
      playerActions: actions,
      game: this.game,
      buildMenu: this.buildMenu,
      emojiTable: this.emojiTable,
      playerActionHandler: this.playerActionHandler,
      playerPanel: this.playerPanel,
      chatIntegration: this.chatIntegration,
      uiState: this.uiState,
      closeMenu: () => {
        this.placementMenu.hideRadialMenu();
        this.closeMenu();
      },
      eventBus: this.eventBus,
    };
    if (placement) {
      this.radialMenu.hideRadialMenu();
      this.placementMenu.setParams(params);
      this.placementMenu.showRadialMenu(screenX!, screenY!);
      return;
    }

    const isFriendlyTarget =
      recipient !== null &&
      recipient.isFriendly(myPlayer) &&
      (!recipient.isDisconnected() ||
        !!this.game.config().gameConfig().continuousPressure);

    this.radialMenu.setCenterButtonAppearance(
      isFriendlyTarget ? donateTroopIcon : swordIcon,
      isFriendlyTarget ? "#22d3ee" : "#0f2744",
      isFriendlyTarget
        ? this.radialMenu.getDefaultCenterIconSize() * 0.75
        : this.radialMenu.getDefaultCenterIconSize(),
    );

    this.radialMenu.setParams(params);
    if (screenX !== null && screenY !== null) {
      this.radialMenu.showRadialMenu(screenX, screenY);
    } else {
      this.radialMenu.refresh();
    }
  }

  async tick() {
    if (!this.radialMenu.isMenuVisible() || this.clickedTile === null) return;
    this.game
      .myPlayer()!
      .actions(this.clickedTile)
      .then((actions) => {
        this.updatePlayerActions(
          this.game.myPlayer()!,
          actions,
          this.clickedTile!,
        );
      });
  }

  closeMenu() {
    if (this.radialMenu.isMenuVisible()) {
      this.radialMenu.hideRadialMenu();
    }

    if (this.buildMenu.isVisible) {
      this.buildMenu.hideMenu();
    }

    if (this.emojiTable.isVisible) {
      this.emojiTable.hideTable();
    }

    if (this.playerPanel.isVisible) {
      this.playerPanel.hide();
    }
  }
}
