import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";

const MIN_RATIO_PERCENT = 1;
const MAX_RATIO_PERCENT = 100;
const DRAG_PIXELS_PER_PERCENT = 1.15;
const WHEEL_THRESHOLD_PX = 38;
const DIAL_EXIT_PADDING_PX = 8;

type GestureMode = "dial" | "linear";

export function clampAttackRatioPercent(value: number): number {
  if (!Number.isFinite(value)) return MIN_RATIO_PERCENT;
  return Math.max(
    MIN_RATIO_PERCENT,
    Math.min(MAX_RATIO_PERCENT, Math.round(value)),
  );
}

export function attackRatioFromVerticalDrag(
  startingValue: number,
  startingY: number,
  currentY: number,
): number {
  return clampAttackRatioPercent(
    startingValue + (startingY - currentY) / DRAG_PIXELS_PER_PERCENT,
  );
}

export function attackRatioFromLinearDrag(
  startingValue: number,
  startingX: number,
  startingY: number,
  currentX: number,
  currentY: number,
): number {
  const increasingPixels = startingY - currentY + (currentX - startingX);
  return clampAttackRatioPercent(
    startingValue + increasingPixels / DRAG_PIXELS_PER_PERCENT,
  );
}

export function attackRatioFromDialRotation(
  startingValue: number,
  rotationDegrees: number,
): number {
  return clampAttackRatioPercent(startingValue + (rotationDegrees / 270) * 99);
}

function pointerAngle(centerX: number, centerY: number, x: number, y: number) {
  return (Math.atan2(y - centerY, x - centerX) * 180) / Math.PI + 90;
}

function shortestAngleDelta(previous: number, current: number): number {
  let delta = current - previous;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

@customElement("attack-ratio-dial")
export class AttackRatioDial extends LitElement {
  @property({ type: Number }) value = 20;
  @property({ type: Number }) step = 10;
  @property({ type: Number }) min = 1;
  @property() footer = "";
  @property() label = "Attack ratio";
  @property({ attribute: "display-value" }) displayValue = "";

  private activePointerId: number | null = null;
  private gestureMode: GestureMode | null = null;
  private linearLastX = 0;
  private linearLastY = 0;
  private linearContinuousValue = 20;
  private dialCenterX = 0;
  private dialCenterY = 0;
  private dialRadius = 0;
  private dialLastAngle = 0;
  private dialContinuousValue = 20;
  private wheelRemainder = 0;
  private wheelSettleTimer: ReturnType<typeof setTimeout> | null = null;

  createRenderRoot() {
    return this;
  }

  disconnectedCallback(): void {
    this.finishGesture();
    if (this.wheelSettleTimer !== null) {
      clearTimeout(this.wheelSettleTimer);
      this.wheelSettleTimer = null;
    }
    super.disconnectedCallback();
  }

  private setValue(value: number): void {
    const nextValue = Math.max(this.min, Math.min(100, Math.round(value)));
    if (nextValue === this.value) return;
    this.value = nextValue;
    this.dispatchEvent(
      new CustomEvent<{ value: number }>("attack-ratio-input", {
        detail: { value: nextValue },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handlePointerDown(event: PointerEvent): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // One finger owns the dial until it is released. Additional pointers remain
    // available to the map for attacks, boats, and camera gestures.
    if (this.activePointerId !== null) return;

    const control = event.currentTarget as HTMLElement;
    this.activePointerId = event.pointerId;
    this.linearLastX = event.clientX;
    this.linearLastY = event.clientY;
    this.linearContinuousValue = this.value;
    const bezel = this.querySelector<HTMLElement>(".atlas-attack-dial__bezel");
    const rect = bezel?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      this.dialCenterX = rect.left + rect.width / 2;
      this.dialCenterY = rect.top + rect.height / 2;
      this.dialRadius = Math.min(rect.width, rect.height) / 2;
      const distance = Math.hypot(
        event.clientX - this.dialCenterX,
        event.clientY - this.dialCenterY,
      );
      if (distance <= this.dialRadius + DIAL_EXIT_PADDING_PX) {
        this.gestureMode = "dial";
        this.dialLastAngle = pointerAngle(
          this.dialCenterX,
          this.dialCenterY,
          event.clientX,
          event.clientY,
        );
        this.dialContinuousValue = this.value;
      } else {
        this.gestureMode = "linear";
      }
    } else {
      this.gestureMode = "linear";
    }
    this.setAttribute("data-dragging", "");
    this.setAttribute("data-gesture-mode", this.gestureMode);
    control.focus({ preventScroll: true });
    try {
      control.setPointerCapture?.(event.pointerId);
    } catch {
      // Mobile Safari can reject capture after a pointer has already ended.
    }
    event.preventDefault();
    event.stopPropagation();
  }

  private handlePointerMove(event: PointerEvent): void {
    if (event.pointerId !== this.activePointerId) return;

    if (this.gestureMode === "dial") {
      const distance = Math.hypot(
        event.clientX - this.dialCenterX,
        event.clientY - this.dialCenterY,
      );
      if (distance > this.dialRadius + DIAL_EXIT_PADDING_PX) {
        this.gestureMode = "linear";
        this.linearLastX = event.clientX;
        this.linearLastY = event.clientY;
        this.linearContinuousValue = this.value;
        this.setAttribute("data-gesture-mode", "linear");
      } else if (distance >= this.dialRadius * 0.22) {
        const angle = pointerAngle(
          this.dialCenterX,
          this.dialCenterY,
          event.clientX,
          event.clientY,
        );
        const delta = shortestAngleDelta(this.dialLastAngle, angle);
        this.dialContinuousValue = Math.max(
          this.min,
          Math.min(
            MAX_RATIO_PERCENT,
            this.dialContinuousValue + (delta / 270) * (100 - this.min),
          ),
        );
        this.dialLastAngle = angle;
        this.setValue(this.dialContinuousValue);
      }
    } else {
      const increasingPixels =
        this.linearLastY - event.clientY + (event.clientX - this.linearLastX);
      this.linearContinuousValue = Math.max(
        this.min,
        Math.min(
          MAX_RATIO_PERCENT,
          this.linearContinuousValue +
            increasingPixels / DRAG_PIXELS_PER_PERCENT,
        ),
      );
      this.linearLastX = event.clientX;
      this.linearLastY = event.clientY;
      this.setValue(this.linearContinuousValue);
    }
    event.preventDefault();
    event.stopPropagation();
  }

  private handlePointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.activePointerId) return;
    const control = event.currentTarget as HTMLElement;
    try {
      if (control.hasPointerCapture?.(event.pointerId)) {
        control.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Capture may already have been released by the browser.
    }
    this.finishGesture();
    event.preventDefault();
    event.stopPropagation();
  }

  private handlePointerCancel(event: PointerEvent): void {
    if (event.pointerId !== this.activePointerId) return;
    this.finishGesture();
    event.stopPropagation();
  }

  private finishGesture(): void {
    this.activePointerId = null;
    this.gestureMode = null;
    this.removeAttribute("data-dragging");
    this.removeAttribute("data-gesture-mode");
  }

  private normalizeWheelDelta(event: WheelEvent): number {
    if (event.deltaMode === 1) return event.deltaY * 16;
    if (event.deltaMode === 2) return event.deltaY * 100;
    return event.deltaY;
  }

  private handleWheel(event: WheelEvent): void {
    event.preventDefault();
    event.stopPropagation();

    this.wheelRemainder -= this.normalizeWheelDelta(event);
    if (Math.abs(this.wheelRemainder) >= WHEEL_THRESHOLD_PX) {
      const direction = Math.sign(this.wheelRemainder);
      this.setValue(this.value + direction * Math.max(1, this.step));
      this.wheelRemainder = 0;
      this.setAttribute("data-wheel-active", "");
    }

    if (this.wheelSettleTimer !== null) {
      clearTimeout(this.wheelSettleTimer);
    }
    this.wheelSettleTimer = setTimeout(() => {
      this.wheelRemainder = 0;
      this.removeAttribute("data-wheel-active");
      this.wheelSettleTimer = null;
    }, 180);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const coarseStep = Math.max(1, this.step);
    let nextValue: number | null = null;

    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        nextValue = this.value + (event.shiftKey ? coarseStep : 1);
        break;
      case "ArrowDown":
      case "ArrowLeft":
        nextValue = this.value - (event.shiftKey ? coarseStep : 1);
        break;
      case "PageUp":
        nextValue = this.value + coarseStep;
        break;
      case "PageDown":
        nextValue = this.value - coarseStep;
        break;
      case "Home":
        nextValue = this.min;
        break;
      case "End":
        nextValue = MAX_RATIO_PERCENT;
        break;
    }

    if (nextValue === null) return;
    event.preventDefault();
    event.stopPropagation();
    this.setValue(nextValue);
  }

  render() {
    const value = Math.max(this.min, Math.min(100, Math.round(this.value)));
    const sweep = ((value - this.min) / (100 - this.min)) * 270;
    const needle = -135 + sweep;

    return html`
      <div
        class="atlas-attack-dial__touchfield"
        role="slider"
        tabindex="0"
        aria-label=${this.label}
        aria-valuemin=${this.min}
        aria-valuemax=${MAX_RATIO_PERCENT}
        aria-valuenow=${value}
        aria-valuetext="${value}%; ${this.displayValue}; ${this.footer}"
        style="--atlas-ratio-sweep: ${sweep}deg; --atlas-ratio-needle: ${needle}deg;"
        @pointerdown=${this.handlePointerDown}
        @pointermove=${this.handlePointerMove}
        @pointerup=${this.handlePointerUp}
        @pointercancel=${this.handlePointerCancel}
        @lostpointercapture=${this.handlePointerCancel}
        @wheel=${this.handleWheel}
        @keydown=${this.handleKeyDown}
      >
        <span class="atlas-attack-dial__legend">${this.label}</span>
        <span class="atlas-attack-dial__bezel" aria-hidden="true">
          <span class="atlas-attack-dial__scale"></span>
          <span class="atlas-attack-dial__face">
            <span class="atlas-attack-dial__rotor"></span>
            <span class="atlas-attack-dial__needle"></span>
            <span class="atlas-attack-dial__cap"></span>
            <span class="atlas-attack-dial__value"
              >${this.displayValue || `${value}%`}</span
            >
          </span>
        </span>
        <span class="atlas-attack-dial__ratio" aria-hidden="true" translate="no"
          >${this.footer || `${value}%`}</span
        >
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "attack-ratio-dial": AttackRatioDial;
  }
}
