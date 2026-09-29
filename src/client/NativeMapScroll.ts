/** Native WebKit scrolling drives camera deltas; the rendered map and HUD stay fixed. */
export class NativeMapScroll {
  static supported(): boolean {
    return (
      /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  }

  private readonly spacer = document.createElement("div");
  private readonly originalStyle: string;
  private readonly abort = new AbortController();
  private readonly observer: MutationObserver;
  private x = 0;
  private y = 0;
  private fingers = 0;
  private pinchDistance = 0;
  private pinched = false;
  private lastScroll = -Infinity;

  constructor(
    private readonly surface: HTMLElement,
    private readonly pan: (x: number, y: number) => void,
    private readonly zoom: (x: number, y: number, delta: number) => void,
    private readonly blocked: () => boolean,
    private readonly selecting: () => boolean,
    private readonly suppressTap: () => void,
  ) {
    this.originalStyle = surface.style.cssText;
    Object.assign(surface.style, {
      overflow: "scroll",
      touchAction: "pan-x pan-y",
      overscrollBehavior: "none",
      scrollbarWidth: "none",
      webkitOverflowScrolling: "touch",
    });
    // Empty layout space, not a huge canvas/texture. Recenter between gestures.
    Object.assign(this.spacer.style, {
      width: "100000px",
      height: "100000px",
      pointerEvents: "none",
    });
    surface.appendChild(this.spacer);
    this.reset();
    const signal = this.abort.signal;
    surface.addEventListener("scroll", this.onScroll, {
      passive: true,
      signal,
    });
    surface.addEventListener("scrollend", this.onScrollEnd, {
      passive: true,
      signal,
    });
    surface.addEventListener("touchstart", this.onTouchStart, {
      passive: false,
      signal,
    });
    surface.addEventListener("touchmove", this.onTouchMove, {
      passive: false,
      signal,
    });
    surface.addEventListener("touchend", this.onTouchEnd, {
      passive: true,
      signal,
    });
    surface.addEventListener("touchcancel", this.onTouchEnd, {
      passive: true,
      signal,
    });
    window.addEventListener("pointerdown", this.onInput, {
      capture: true,
      signal,
    });
    window.addEventListener("keydown", this.stop, { capture: true, signal });
    window.addEventListener("blur", this.stop, { signal });
    document.addEventListener("visibilitychange", this.stop, { signal });
    this.observer = new MutationObserver(() => {
      if (this.blocked()) this.stop();
    });
    this.observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  private reset() {
    this.surface.scrollLeft = 50000;
    this.surface.scrollTop = 50000;
    this.x = this.surface.scrollLeft;
    this.y = this.surface.scrollTop;
  }

  stop = () => {
    // Removing scrollability cancels WebKit's native deceleration, including
    // when a HUD touch/idle transition interrupts it outside this surface.
    this.surface.style.overflow = "hidden";
    this.reset();
    this.surface.style.overflow = "scroll";
    this.lastScroll = -Infinity;
  };

  private onInput = (event: PointerEvent) => {
    if (!event.composedPath().includes(this.surface)) this.stop();
  };

  private onScrollEnd = () => {
    // Rebase only after native motion finishes, never during touch arbitration.
    if (
      this.fingers === 0 &&
      (this.x < 10000 || this.x > 90000 || this.y < 10000 || this.y > 90000)
    )
      this.reset();
  };

  private onScroll = () => {
    const x = this.surface.scrollLeft,
      y = this.surface.scrollTop;
    const dx = this.x - x,
      dy = this.y - y;
    this.x = x;
    this.y = y;
    if (!dx && !dy) return;
    if (this.blocked() || this.selecting() || this.pinched || document.hidden) {
      this.stop();
      return;
    }
    this.lastScroll = performance.now();
    this.pan(dx, dy);
  };

  private onTouchStart = (event: TouchEvent) => {
    if (this.fingers === 0) {
      if (performance.now() - this.lastScroll < 120) this.suppressTap();
      // Do not remove scrollability during touchstart: WebKit chooses the
      // gesture's scroll node here, and toggling overflow can detach it for
      // the entire gesture. A finger naturally arrests native deceleration.
      this.x = this.surface.scrollLeft;
      this.y = this.surface.scrollTop;
      this.pinched = false;
    }
    this.fingers = event.touches.length;
    if (this.fingers >= 2) {
      this.pinched = true;
      this.suppressTap();
      this.pinchDistance = this.distance(event);
      this.stop();
      if (event.cancelable) event.preventDefault();
    }
  };

  private distance(event: TouchEvent) {
    return Math.hypot(
      event.touches[0].clientX - event.touches[1].clientX,
      event.touches[0].clientY - event.touches[1].clientY,
    );
  }

  private onTouchMove = (event: TouchEvent) => {
    if (this.blocked() || this.selecting() || this.pinched) {
      if (event.cancelable) event.preventDefault();
    }
    if (this.blocked() || this.selecting() || event.touches.length < 2) return;
    const distance = this.distance(event);
    const delta = distance - this.pinchDistance;
    if (Math.abs(delta) > 1) {
      this.zoom(
        (event.touches[0].clientX + event.touches[1].clientX) / 2,
        (event.touches[0].clientY + event.touches[1].clientY) / 2,
        -delta * 2,
      );
      this.pinchDistance = distance;
    }
  };

  private onTouchEnd = (event: TouchEvent) => {
    this.fingers = event.touches.length;
    if (
      event.type === "touchcancel" ||
      this.pinched ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      this.stop();
    // Keep the pinch latch until the next gesture, avoiding an accidental pan
    // with the remaining finger or a delayed native scroll event.
  };

  destroy() {
    this.stop();
    this.abort.abort();
    this.observer.disconnect();
    this.spacer.remove();
    this.surface.style.cssText = this.originalStyle;
  }
}
