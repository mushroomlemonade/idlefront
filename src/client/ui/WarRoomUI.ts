import { Howl } from "howler";
import { assetUrl } from "../../core/AssetUrls";
import { UserSettings } from "../../core/game/UserSettings";
import { UiHapticController } from "./Haptics";

export type UiFidelity = "full" | "reduced" | "static";

const FULL_FIDELITY_FPS = 50;
const WARMUP_MS = 3_000;
const SAMPLE_WINDOW_MS = 2_000;
const WINDOWS_BEFORE_REDUCTION = 3;

/**
 * Owns UI-only quality adaptation. It never reads from or writes to the game
 * renderer. Components consume the data-ui-fidelity attribute through CSS.
 */
export class UiFidelityController {
  private fidelity: UiFidelity = "full";
  private raf: number | null = null;
  private startedAt = performance.now();
  private windowStartedAt = this.startedAt;
  private frames = 0;
  private slowWindows = 0;
  private media = matchMedia("(prefers-reduced-motion: reduce)");

  constructor(private readonly root: HTMLElement = document.body) {
    this.setFidelity("full");
    this.onMotionPreferenceChange();
    this.media.addEventListener("change", this.onMotionPreferenceChange);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    if (!document.hidden) this.start();
  }

  current(): UiFidelity {
    return this.fidelity;
  }

  dispose(): void {
    this.stop();
    this.media.removeEventListener("change", this.onMotionPreferenceChange);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private setFidelity(next: UiFidelity): void {
    if (this.fidelity === next && this.root.dataset.uiFidelity === next) return;
    this.fidelity = next;
    this.root.dataset.uiFidelity = next;
    this.root.dispatchEvent(
      new CustomEvent<UiFidelity>("ui-fidelity-change", { detail: next }),
    );
  }

  private onMotionPreferenceChange = (): void => {
    if (this.media.matches) {
      this.setFidelity("static");
      this.stop();
      return;
    }
    if (this.fidelity === "static") this.setFidelity("full");
    this.startedAt = performance.now();
    this.windowStartedAt = this.startedAt;
    this.frames = 0;
    this.slowWindows = 0;
    if (!document.hidden) this.start();
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) {
      this.stop();
    } else if (this.fidelity !== "static") {
      this.startedAt = performance.now();
      this.windowStartedAt = this.startedAt;
      this.frames = 0;
      this.start();
    }
  };

  private start(): void {
    if (this.raf !== null || this.fidelity !== "full") return;
    this.raf = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.raf === null) return;
    cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private tick = (now: number): void => {
    this.raf = null;
    if (this.fidelity !== "full" || document.hidden) return;
    this.frames++;

    if (now - this.startedAt >= WARMUP_MS) {
      const elapsed = now - this.windowStartedAt;
      if (elapsed >= SAMPLE_WINDOW_MS) {
        const fps = (this.frames * 1_000) / Math.max(1, elapsed);
        this.slowWindows = fps < FULL_FIDELITY_FPS ? this.slowWindows + 1 : 0;
        this.frames = 0;
        this.windowStartedAt = now;
        if (this.slowWindows >= WINDOWS_BEFORE_REDUCTION) {
          this.setFidelity("reduced");
          return;
        }
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}

/** Subtle, opt-in UI feedback that follows the existing SFX volume. */
export class UiSoundController {
  private clickSound: Howl | null = null;
  private lastPlayedAt = 0;

  constructor(private readonly root: Document = document) {
    root.addEventListener("click", this.onClick, { capture: true });
  }

  dispose(): void {
    this.root.removeEventListener("click", this.onClick, { capture: true });
    this.clickSound?.unload();
    this.clickSound = null;
  }

  private onClick = (event: MouseEvent): void => {
    const selector = [
      ".atlas-war-button:not(:disabled)",
      ".atlas-action-button:not(:disabled)",
      ".atlas-icon-button:not(:disabled)",
      ".atlas-nav-item:not(:disabled)",
      ".atlas-menu-trigger:not(:disabled)",
      ".atlas-modal-close:not(:disabled)",
      ".atlas-modal-tab",
      ".atlas-control-deck button:not(:disabled)",
      "button.atlas-o-button:not(:disabled)",
      'input[type="range"]',
    ].join(",");
    const control = event
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.matches(selector),
      );
    if (!control || control.dataset.uiSound === "none") return;

    const volume = new UserSettings().soundEffectsVolume();
    if (volume <= 0) return;
    const now = performance.now();
    if (now - this.lastPlayedAt < 45) return;
    this.lastPlayedAt = now;

    this.clickSound ??= new Howl({
      src: [assetUrl("sounds/effects/click.mp3")],
      preload: false,
    });
    const id = this.clickSound.play();
    this.clickSound.volume(Math.min(0.38, volume * volume * 0.38), id);
    const rate = control.matches('[aria-expanded="true"], [role="tab"]')
      ? 0.9
      : control.matches('input[type="range"]')
        ? 1.08
        : 1;
    this.clickSound.rate(rate, id);
  };
}

/** Short, deliberate flourishes for actions that change the visible stage. */
export class UiFlourishController {
  private flourish: HTMLDivElement | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly root: Document = document) {
    root.addEventListener("click", this.onClick, { capture: true });
  }

  dispose(): void {
    this.root.removeEventListener("click", this.onClick, { capture: true });
    if (this.cleanupTimer !== null) clearTimeout(this.cleanupTimer);
    this.flourish?.remove();
    this.flourish = null;
  }

  private onClick = (event: MouseEvent): void => {
    if (
      document.body.dataset.uiFidelity === "static" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const path = event.composedPath();
    const control = path.find(
      (node): node is HTMLElement => node instanceof HTMLElement,
    );
    if (!control) return;

    const interactive = control.closest<HTMLElement>(
      ".atlas-quick-play, .atlas-lobby-card, .pw-entry-control, .nav-menu-item[data-page], #hamburger-btn, #desktop-menu-button",
    );
    if (!interactive) return;

    if (
      interactive.matches(
        ".atlas-quick-play, .atlas-lobby-card, .pw-entry-control",
      )
    ) {
      this.play("deploy", this.activationOrigin(event, interactive));
    } else if (interactive.matches("#hamburger-btn, #desktop-menu-button")) {
      this.play("drawer");
    } else if (interactive.dataset.page !== "page-play") {
      this.play("page");
    }
  };

  private activationOrigin(
    event: MouseEvent,
    interactive: HTMLElement,
  ): { x: number; y: number } {
    // Pointer/touch-generated click events carry the activation coordinates.
    // Keyboard and assistive-tech activations have detail === 0, so originate
    // the flourish from the control itself instead of the viewport centre.
    if (event.detail !== 0) {
      return { x: event.clientX, y: event.clientY };
    }

    const bounds = interactive.getBoundingClientRect();
    return {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    };
  }

  private play(
    kind: "deploy" | "drawer" | "page",
    origin?: { x: number; y: number },
  ): void {
    if (this.cleanupTimer !== null) clearTimeout(this.cleanupTimer);
    this.flourish?.remove();
    const flourish = document.createElement("div");
    flourish.className = `atlas-flourish atlas-flourish--${kind}`;
    flourish.setAttribute("aria-hidden", "true");
    if (origin) {
      flourish.style.setProperty("--atlas-flourish-x", `${origin.x}px`);
      flourish.style.setProperty("--atlas-flourish-y", `${origin.y}px`);
    }
    flourish.append(
      document.createElement("i"),
      document.createElement("i"),
      document.createElement("i"),
    );
    document.body.append(flourish);
    this.flourish = flourish;
    this.cleanupTimer = setTimeout(() => {
      flourish.remove();
      if (this.flourish === flourish) this.flourish = null;
      this.cleanupTimer = null;
    }, 900);
  }
}

let fidelityController: UiFidelityController | null = null;
let soundController: UiSoundController | null = null;
let flourishController: UiFlourishController | null = null;
let hapticController: UiHapticController | null = null;

export function initWarRoomUI(): void {
  fidelityController ??= new UiFidelityController();
  soundController ??= new UiSoundController();
  flourishController ??= new UiFlourishController();
  hapticController ??= new UiHapticController();
}
