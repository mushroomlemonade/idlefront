import { EventBus, GameEvent } from "../core/EventBus";
import { Cell, UnitType } from "../core/game/Game";
import {
  CenterCameraEvent,
  DragEvent,
  ZOOM_DELTA_DIVISOR,
  ZoomEvent,
} from "./InputHandler";
import { GameView, PlayerView, UnitView } from "./view";

export class GoToPlayerEvent implements GameEvent {
  constructor(
    public player: PlayerView,
    public zoom?: number,
  ) {}
}

export class GoToPositionEvent implements GameEvent {
  constructor(
    public x: number,
    public y: number,
    public zoom?: number,
    public wide = false,
    public zoomSpeed = 6,
  ) {}
}

export class GoToUnitEvent implements GameEvent {
  constructor(public unit: UnitView) {}
}

export class CinematicFollowEvent implements GameEvent {
  constructor(
    public unit: UnitView,
    public zoom = 4.8,
  ) {}
}

/** Resolve a UI map pick using the same camera as normal game input. */
export class ResolveMapPositionEvent implements GameEvent {
  constructor(
    public x: number,
    public y: number,
    public resolve: (cell: Cell) => void,
  ) {}
}

/** Show the complete board while an initial/reconnecting view paints in. */
export class FitMapEvent implements GameEvent {}
/** Camera-only state: never changes the server player or other devices. */
export class IdleCameraEvent implements GameEvent {
  constructor(public readonly enabled: boolean) {}
}

export const GOTO_INTERVAL_MS = 16;
export const CAMERA_MAX_SPEED = 15;
export const CAMERA_SMOOTHING = 0.03;

export class TransformHandler {
  private cinematicSubject?: UnitView;
  private cinematicImpactZoom = false;
  private targetZoomSpeed = 6;
  private idleDetailZoom = 4.8;
  private idleCameraRestore?: { x: number; y: number; scale: number };
  public scale: number = 1.8;
  private _boundingRect: DOMRect;
  public offsetX: number = -350;
  public offsetY: number = -200;
  private lastGoToCallTime: number | null = null;

  private target: Cell | null;
  private targetScale: number | null = null;
  private intervalID: NodeJS.Timeout | null = null;
  private changed = false;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private canvas: HTMLElement,
  ) {
    this._boundingRect = this.canvas.getBoundingClientRect();
    this.eventBus.on(ZoomEvent, (e) => this.onZoom(e));
    this.eventBus.on(DragEvent, (e) => this.onMove(e));
    this.eventBus.on(GoToPlayerEvent, (e) => this.onGoToPlayer(e));
    this.eventBus.on(GoToPositionEvent, (e) => this.onGoToPosition(e));
    this.eventBus.on(GoToUnitEvent, (e) => this.onGoToUnit(e));
    this.eventBus.on(CinematicFollowEvent, (e) => {
      if (!this.idleCameraRestore) return;
      if (this.cinematicSubject === e.unit) return;
      this.clearTarget();
      this.cinematicSubject = e.unit;
      this.idleDetailZoom = e.zoom;
      this.targetScale = e.zoom;
      this.target = new Cell(
        this.game.x(e.unit.tile()),
        this.game.y(e.unit.tile()),
      );
      this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
    });
    this.eventBus.on(ResolveMapPositionEvent, (e) => {
      e.resolve(this.screenToWorldCoordinates(e.x, e.y));
    });
    this.eventBus.on(IdleCameraEvent, (e) => {
      if (e.enabled && !this.idleCameraRestore) {
        this.idleDetailZoom = 4.8;
        this.idleCameraRestore = {
          x: this.offsetX,
          y: this.offsetY,
          scale: this.scale,
        };
        this.clearTarget();
        this.constrainIdleCamera();
      } else if (!e.enabled && this.idleCameraRestore) {
        const saved = this.idleCameraRestore;
        this.idleCameraRestore = undefined;
        this.override(saved.x, saved.y, saved.scale);
      }
    });
    this.eventBus.on(CenterCameraEvent, () => this.centerCamera());
    this.eventBus.on(FitMapEvent, () => {
      this.updateCanvasBoundingRect();
      this.centerAll();
    });
  }

  public updateCanvasBoundingRect() {
    // CSS perspective changes the visual bounding box, not the renderer's viewport.
    // Feeding that enlarged box back into camera math moves the followed subject off-center.
    if (this.idleCameraRestore) {
      this._boundingRect = new DOMRect(
        this._boundingRect.left,
        this._boundingRect.top,
        this.canvas.clientWidth || this._boundingRect.width,
        this.canvas.clientHeight || this._boundingRect.height,
      );
    } else this._boundingRect = this.canvas.getBoundingClientRect();
    if (this.idleCameraRestore) this.constrainIdleCamera();
  }

  /** Keep the complete cinematic viewport inside the board, including orbit overscan. */
  private constrainIdleCamera() {
    const { width, height } = this.boundingRect();
    const mapWidth = this.game.width(),
      mapHeight = this.game.height();
    const radius = Math.hypot(width, height) * 0.6;
    const minimum = Math.max(
      this.idleDetailZoom,
      (radius * 2 + 4) / Math.min(mapWidth, mapHeight),
    );
    const oldScale = this.scale;
    this.scale = Math.max(this.scale, minimum);
    this.offsetX +=
      (width - mapWidth) * (1 / (2 * oldScale) - 1 / (2 * this.scale));
    this.offsetY +=
      (height - mapHeight) * (1 / (2 * oldScale) - 1 / (2 * this.scale));
    if (this.targetScale !== null)
      this.targetScale = Math.max(this.targetScale, minimum);
    const margin = radius / this.scale + 1;
    const centerX =
      this.offsetX + mapWidth / 2 + (width - mapWidth) / (2 * this.scale);
    const centerY =
      this.offsetY + mapHeight / 2 + (height - mapHeight) / (2 * this.scale);
    this.offsetX +=
      Math.max(margin, Math.min(mapWidth - margin, centerX)) - centerX;
    this.offsetY +=
      Math.max(margin, Math.min(mapHeight - margin, centerY)) - centerY;
    this.changed = true;
  }

  boundingRect(): DOMRect {
    return this._boundingRect;
  }

  width(): number {
    return this.boundingRect().width;
  }
  hasChanged(): boolean {
    return this.changed;
  }
  resetChanged() {
    this.changed = false;
  }

  handleTransform(context: CanvasRenderingContext2D) {
    // Disable image smoothing for pixelated effect
    context.imageSmoothingEnabled = false;

    // Apply zoom and pan
    context.setTransform(
      this.scale,
      0,
      0,
      this.scale,
      this.game.width() / 2 - this.offsetX * this.scale,
      this.game.height() / 2 - this.offsetY * this.scale,
    );
  }

  worldToCanvasCoordinates(cell: Cell): { x: number; y: number } {
    // Step 1: Convert from Cell coordinates to game coordinates
    // (reverse of Math.floor operation - we'll use the exact values)
    const gameX = cell.x;
    const gameY = cell.y;

    // Step 2: Reverse the game center offset calculation
    // Original: gameX = centerX + this.game.width() / 2
    // Therefore: centerX = gameX - this.game.width() / 2
    const centerX = gameX - this.game.width() / 2;
    const centerY = gameY - this.game.height() / 2;

    // Step 3: Reverse the world point calculation
    // Original: centerX = (canvasX - this.game.width() / 2) / this.scale + this.offsetX
    // Therefore: canvasX = (centerX - this.offsetX) * this.scale + this.game.width() / 2
    const canvasX =
      (centerX - this.offsetX) * this.scale + this.game.width() / 2;
    const canvasY =
      (centerY - this.offsetY) * this.scale + this.game.height() / 2;

    return { x: canvasX, y: canvasY };
  }

  worldToScreenCoordinates(cell: Cell): { x: number; y: number } {
    // Step 1-3: Convert world coordinates to canvas coordinates in worldToCanvasCoordinates
    // Step 4 only where needed: Convert canvas coordinates back to screen coordinates
    const canvasCoords = this.worldToCanvasCoordinates(cell);
    return this.canvasToScreenCoordinates(canvasCoords.x, canvasCoords.y);
  }

  screenToWorldCoordinates(screenX: number, screenY: number): Cell {
    const f = this.screenToWorldCoordinatesFloat(screenX, screenY);
    return new Cell(Math.floor(f.x), Math.floor(f.y));
  }

  /** Like screenToWorldCoordinates but returns sub-tile precision. */
  screenToWorldCoordinatesFloat(
    screenX: number,
    screenY: number,
  ): { x: number; y: number } {
    const canvasCoords = this.screenToCanvasCoordinates(screenX, screenY);
    const gameX =
      (canvasCoords.x - this.game.width() / 2) / this.scale +
      this.offsetX +
      this.game.width() / 2;
    const gameY =
      (canvasCoords.y - this.game.height() / 2) / this.scale +
      this.offsetY +
      this.game.height() / 2;
    return { x: gameX, y: gameY };
  }

  canvasToScreenCoordinates(
    canvasX: number,
    canvasY: number,
  ): { x: number; y: number } {
    const canvasRect = this.boundingRect();
    return {
      x: canvasX + canvasRect.left,
      y: canvasY + canvasRect.top,
    };
  }

  screenToCanvasCoordinates(
    screenX: number,
    screenY: number,
  ): { x: number; y: number } {
    const canvasRect = this.boundingRect();
    return { x: screenX - canvasRect.left, y: screenY - canvasRect.top };
  }

  screenBoundingRect(): [Cell, Cell] {
    const canvasRect = this.boundingRect();
    const canvasWidth = canvasRect.width;
    const canvasHeight = canvasRect.height;

    const LeftX = -this.game.width() / 2 / this.scale + this.offsetX;
    const TopY = -this.game.height() / 2 / this.scale + this.offsetY;

    const gameLeftX = LeftX + this.game.width() / 2;
    const gameTopY = TopY + this.game.height() / 2;

    const rightX =
      (canvasWidth - this.game.width() / 2) / this.scale + this.offsetX;
    const bottomY =
      (canvasHeight - this.game.height() / 2) / this.scale + this.offsetY;

    const gameRightX = rightX + this.game.width() / 2;
    const gameBottomY = bottomY + this.game.height() / 2;

    return [
      new Cell(Math.floor(gameLeftX), Math.floor(gameTopY)),
      new Cell(Math.floor(gameRightX), Math.floor(gameBottomY)),
    ];
  }

  isOnScreen(cell: Cell): boolean {
    const [topLeft, bottomRight] = this.screenBoundingRect();
    return (
      cell.x > topLeft.x &&
      cell.x < bottomRight.x &&
      cell.y > topLeft.y &&
      cell.y < bottomRight.y
    );
  }

  screenCenter(): { screenX: number; screenY: number } {
    if (this.idleCameraRestore) {
      return {
        screenX:
          this.offsetX +
          this.game.width() / 2 +
          (this.width() - this.game.width()) / (2 * this.scale),
        screenY:
          this.offsetY +
          this.game.height() / 2 +
          (this.boundingRect().height - this.game.height()) / (2 * this.scale),
      };
    }
    const [upperLeft, bottomRight] = this.screenBoundingRect();
    return {
      screenX: upperLeft.x + Math.floor((bottomRight.x - upperLeft.x) / 2),
      screenY: upperLeft.y + Math.floor((bottomRight.y - upperLeft.y) / 2),
    };
  }

  onGoToPlayer(event: GoToPlayerEvent) {
    this.clearTarget();
    const nameLocation = event.player.nameLocation();
    if (!nameLocation) {
      return;
    }
    this.target = new Cell(nameLocation.x, nameLocation.y);
    this.targetScale = event.zoom ?? null;
    if (this.idleCameraRestore) {
      // Use the existing server-fitted label rectangle; no territory tile scan.
      const labelWidth = Math.max(
        1,
        nameLocation.bounds?.width ??
          nameLocation.size * Math.max(1, event.player.name().length),
      );
      const labelHeight = Math.max(
        1,
        nameLocation.bounds?.height ?? nameLocation.size * 3,
      );
      this.idleDetailZoom = 0.1;
      this.targetScale = Math.min(
        4.8,
        (this.width() * 0.55) / labelWidth,
        (this.boundingRect().height * 0.45) / labelHeight,
      );
    }
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  onGoToPosition(event: GoToPositionEvent) {
    this.idleDetailZoom = event.wide ? 0.1 : 4.8;
    this.clearTarget();
    this.targetZoomSpeed = event.zoomSpeed;
    this.target = new Cell(event.x, event.y);
    this.targetScale = event.zoom ?? null;
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  onGoToUnit(event: GoToUnitEvent) {
    this.clearTarget();
    this.target = new Cell(
      this.game.x(event.unit.lastTile()),
      this.game.y(event.unit.lastTile()),
    );
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  centerCamera() {
    this.clearTarget();
    const player = this.game.myPlayer();
    const nameLocation = player?.nameLocation();
    if (!nameLocation) return;
    this.target = new Cell(nameLocation.x, nameLocation.y);
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  private goTo() {
    if (this.cinematicSubject) {
      const unit = this.cinematicSubject;
      if (
        !unit.isActive() ||
        !this.game.isTileVisible(unit.tile()) ||
        (this.game.unit && this.game.unit(unit.id()) !== unit)
      ) {
        this.clearTarget();
        return;
      }
      const alpha = Math.max(
        0,
        Math.min(
          1,
          (performance.now() - this.game.lastViewUpdateMs) /
            this.game.config().msPerTick(),
        ),
      );
      const previous = unit.state.lastPos;
      const tile = unit.tile();
      this.target = new Cell(
        this.game.x(previous) +
          (this.game.x(tile) - this.game.x(previous)) * alpha,
        this.game.y(previous) +
          (this.game.y(tile) - this.game.y(previous)) * alpha,
      );
      const type = unit.type?.();
      const impact = unit.targetTile?.();
      if (
        (type === UnitType.HydrogenBomb || type === UnitType.AtomBomb) &&
        impact !== undefined &&
        this.game.isTileVisible(impact)
      ) {
        const speed = Math.max(
          1,
          Math.hypot(
            this.game.x(tile) - this.game.x(previous),
            this.game.y(tile) - this.game.y(previous),
          ),
        );
        const distance = Math.hypot(
          this.game.x(impact) - this.target.x,
          this.game.y(impact) - this.target.y,
        );
        if (distance <= speed * 3) {
          this.cinematicImpactZoom = true;
          this.idleDetailZoom = 0.1;
          const diameter = this.game.config().nukeMagnitudes(type).outer * 2;
          this.targetScale = Math.min(
            1.8,
            (this.width() * 0.22) / diameter,
            (this.boundingRect().height * 0.22) / diameter,
          );
        }
      }
    }
    if (this.idleCameraRestore) this.constrainIdleCamera();
    const { screenX, screenY } = this.screenCenter();

    if (this.target === null) throw new Error("null target");

    const positionClose =
      Math.abs(this.target.x - screenX) + Math.abs(this.target.y - screenY) < 2;
    const scaleClose =
      this.targetScale === null ||
      Math.abs(this.scale - this.targetScale) < 0.01;
    if (positionClose && scaleClose && !this.cinematicSubject) {
      this.clearTarget();
      return;
    }

    let dt: number;
    const now = window.performance.now();
    if (this.lastGoToCallTime === null) {
      dt = GOTO_INTERVAL_MS;
    } else {
      dt = now - this.lastGoToCallTime;
    }
    this.lastGoToCallTime = now;

    // Follow moving subjects tightly; scenic transitions retain their gentle easing.
    const r =
      1 -
      Math.pow(this.cinematicSubject ? 0.000001 : CAMERA_SMOOTHING, dt / 1000);

    this.offsetX += Math.max(
      Math.min((this.target.x - screenX) * r, CAMERA_MAX_SPEED),
      -CAMERA_MAX_SPEED,
    );
    this.offsetY += Math.max(
      Math.min((this.target.y - screenY) * r, CAMERA_MAX_SPEED),
      -CAMERA_MAX_SPEED,
    );

    if (this.targetScale !== null) {
      const oldScale = this.scale;
      const zoomSmoothing = 0.7;
      const zoomR = 1 - Math.pow(zoomSmoothing, dt / 1000);
      const diff = this.targetScale - this.scale;
      const smoothStep = diff * zoomR;
      const minStep =
        Math.sign(diff) *
        Math.min(
          Math.abs(diff),
          ((this.cinematicImpactZoom ? 24 : this.targetZoomSpeed) * dt) / 1000,
        );
      this.scale +=
        Math.abs(smoothStep) >= Math.abs(minStep) ? smoothStep : minStep;
      // Keep screen center pinned as scale changes: (canvasSize - mapSize) / (2 * scale)
      // shifts the apparent center when canvas != map dimensions (always on mobile).
      const { width: canvasWidth, height: canvasHeight } = this.boundingRect();
      this.offsetX +=
        (canvasWidth - this.game.width()) *
        (1 / (2 * oldScale) - 1 / (2 * this.scale));
      this.offsetY +=
        (canvasHeight - this.game.height()) *
        (1 / (2 * oldScale) - 1 / (2 * this.scale));
    }

    if (this.idleCameraRestore) this.constrainIdleCamera();
    this.changed = true;
  }

  onZoom(event: ZoomEvent) {
    this.clearTarget();
    const oldScale = this.scale;
    const zoomFactor = 1 + event.delta / ZOOM_DELTA_DIVISOR;
    this.scale /= zoomFactor;

    // Clamp the scale to prevent extreme zooming
    const minScale = Math.min(
      0.2,
      this.boundingRect().width / this.game.width(),
      this.boundingRect().height / this.game.height(),
    );
    this.scale = Math.max(minScale, Math.min(20, this.scale));

    const canvasCoords = this.screenToCanvasCoordinates(event.x, event.y);

    // Calculate the world point we want to zoom towards
    const zoomPointX =
      (canvasCoords.x - this.game.width() / 2) / oldScale + this.offsetX;
    const zoomPointY =
      (canvasCoords.y - this.game.height() / 2) / oldScale + this.offsetY;

    // Adjust the offset
    this.offsetX =
      zoomPointX - (canvasCoords.x - this.game.width() / 2) / this.scale;
    this.offsetY =
      zoomPointY - (canvasCoords.y - this.game.height() / 2) / this.scale;
    this.clampOffsets();
    this.changed = true;
  }

  private clampOffsets() {
    const canvasRect = this.boundingRect();
    const canvasWidth = canvasRect.width;
    const canvasHeight = canvasRect.height;
    const gameWidth = this.game.width();
    const gameH = this.game.height();
    const scale = this.scale;

    // Allow panning so that up to half of the viewport can be outside the map on each side.
    // This lets a map corner be placed at the screen center, but no further.
    // Derivation (X axis):
    //   gameLeftX = -gameWidth/(2*scale) + offsetX + gameWidth/2 >= -vw/2
    //   gameRightX = (canvasWidth - gameWidth/2)/scale + offsetX + gameWidth/2 <= gameWidth + vw/2
    // Solving gives:
    //   minOffsetX = -gameWidth/2 + (gameWidth - canvasWidth) / (2*scale)
    //   maxOffsetX =  gameWidth/2 + (gameWidth - canvasWidth) / (2*scale)
    const minOffsetX = -gameWidth / 2 + (gameWidth - canvasWidth) / (2 * scale);
    const maxOffsetX = gameWidth / 2 + (gameWidth - canvasWidth) / (2 * scale);

    const minOffsetY = -gameH / 2 + (gameH - canvasHeight) / (2 * scale);
    const maxOffsetY = gameH / 2 + (gameH - canvasHeight) / (2 * scale);

    // Clamp offsets within computed bounds on each axis
    if (this.offsetX < minOffsetX) {
      this.offsetX = minOffsetX;
    } else if (this.offsetX > maxOffsetX) {
      this.offsetX = maxOffsetX;
    }

    if (this.offsetY < minOffsetY) {
      this.offsetY = minOffsetY;
    } else if (this.offsetY > maxOffsetY) {
      this.offsetY = maxOffsetY;
    }
  }

  onMove(event: DragEvent) {
    this.clearTarget();
    this.offsetX -= event.deltaX / this.scale;
    this.offsetY -= event.deltaY / this.scale;
    this.clampOffsets();
    this.changed = true;
  }

  private clearTarget() {
    this.cinematicSubject = undefined;
    this.cinematicImpactZoom = false;
    this.targetZoomSpeed = 6;
    if (this.intervalID !== null) {
      clearInterval(this.intervalID);
      this.intervalID = null;
    }
    this.target = null;
    this.targetScale = null;
  }

  override(x: number = 0, y: number = 0, s: number = 1) {
    //hardset view position
    this.clearTarget();
    this.offsetX = x;
    this.offsetY = y;
    this.scale = s;
    this.changed = true;
  }

  centerAll(fit: number = 1) {
    //position entire map centered on the screen

    const vpWidth = this.boundingRect().width;
    const vpHeight = this.boundingRect().height;
    const mapWidth = this.game.width();
    const mapHeight = this.game.height();

    const scHor = (vpWidth / mapWidth) * fit;
    const scVer = (vpHeight / mapHeight) * fit;
    const tScale = Math.min(scHor, scVer);

    const oHor = (mapWidth - vpWidth) / 2 / tScale;
    const oVer = (mapHeight - vpHeight) / 2 / tScale;

    this.override(oHor, oVer, tScale);
  }
}
