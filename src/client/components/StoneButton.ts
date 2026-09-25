import { css, html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

export const STONE_BUTTON_VARIANTS = [
  "quartz",
  "obsidian",
  "amethyst",
  "ruby",
  "emerald",
] as const;

export const STONE_BUTTON_SIZES = ["compact", "standard", "hero"] as const;

export const STONE_BUTTON_MIRRORS = ["auto", "normal", "flipped"] as const;

export type StoneButtonVariant = (typeof STONE_BUTTON_VARIANTS)[number];
export type StoneButtonSize = (typeof STONE_BUTTON_SIZES)[number];
export type StoneButtonMirror = (typeof STONE_BUTTON_MIRRORS)[number];
export type StoneButtonType = "button" | "submit" | "reset";

export type StoneToggleRequestDetail = {
  pressed: boolean;
};

const optionalBooleanConverter = {
  fromAttribute(value: string | null): boolean | undefined {
    if (value === null) return undefined;
    return value.toLowerCase() !== "false";
  },
  toAttribute(value: boolean | undefined): string | null {
    if (value === undefined) return null;
    return String(value);
  },
};

type PointerPosition = {
  clientX: number;
  clientY: number;
};

// A mouse click can complete before Safari paints its first active frame. Keep
// the physical down-state around long enough to be seen, while still feeling
// substantially faster than a navigation transition.
const MINIMUM_STONE_PRESS_MS = 150;
const MINIMUM_POST_RELEASE_PRESS_MS = 110;

/**
 * Quietly varies the existing hand-shaped silhouette without runtime
 * randomness. FNV-1a is deterministic in every browser, while its low bit is
 * enough to choose which horizontal orientation a stone receives.
 */
export function stoneButtonMirrorFor(
  variant: StoneButtonVariant,
  stableKey: string,
): Exclude<StoneButtonMirror, "auto"> {
  const source = `${variant}\u001f${stableKey}`;
  let hash = 0x811c9dc5;
  for (const character of source) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash & 1) === 0 ? "normal" : "flipped";
}

/**
 * A tactile, keyboard-accessible control with an optically layered stone face.
 *
 * The photographic material layer is optional. Each variant has a complete CSS
 * fallback and will progressively pick up its matching asset from
 * `resources/images/ui/materials/stones/` when that asset is present.
 *
 * @slot icon - Leading icon or small medallion.
 * @slot - Primary button label when the named `label` slot is not used.
 * @slot label - Primary button label.
 * @slot detail - Optional secondary line.
 * @csspart button - The native button element.
 * @csspart projection - The refracted light projected below the stone.
 * @csspart content - Label and icon content.
 *
 * Supplying `pressed` puts the control in toggle mode. The value is controlled:
 * activating the native button emits `stone-toggle-request` with the requested
 * next value, but never mutates `pressed` on the consumer's behalf.
 *
 * The default `mirror="auto"` deterministically orients the variant's existing
 * asymmetric silhouette from the slotted text. Supply `shape-key` when labels
 * are dynamic, or set `mirror` to `normal`/`flipped` for explicit art direction.
 */
@customElement("idlefront-stone-button")
export class IdlefrontStoneButton extends LitElement {
  static shadowRootOptions: ShadowRootInit = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  @property({ reflect: true }) variant: StoneButtonVariant = "quartz";
  @property({ reflect: true }) size: StoneButtonSize = "standard";
  @property({ reflect: true }) mirror: StoneButtonMirror = "auto";
  @property({ attribute: "shape-key" }) shapeKey = "";
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ type: Boolean, reflect: true }) loading = false;
  @property({ reflect: true, converter: optionalBooleanConverter })
  pressed: boolean | undefined = undefined;
  @property({ attribute: "type" }) type: StoneButtonType = "button";
  @property() name = "";
  @property() value = "";
  @property({ attribute: "accessible-label" }) accessibleLabel = "";

  private pointerFrame: number | undefined;
  private pendingPointer: PointerPosition | undefined;
  private impactPhase = false;
  private pressStartedAt = 0;
  private pressReleaseTimer: number | undefined;
  private activePointerId: number | undefined;

  static styles = css`
    :host {
      --stone-image: url("/images/ui/materials/stones/quartz.webp");
      --stone-deep: #7f8484;
      --stone-shadow: #373b3d;
      --stone-mid: #d4d8d5;
      --stone-light: #fffefa;
      --stone-flare: 246 255 249;
      --stone-caustic: 208 239 225;
      --stone-ink: #202827;
      --stone-ink-highlight: rgb(255 255 255 / 0.86);
      --stone-body-opacity: 44%;
      --stone-mineral-opacity: 0.48;
      --stone-backdrop-blur: 1.4px;
      --stone-backdrop-saturation: 1.22;
      --stone-backdrop-filter: blur(var(--stone-backdrop-blur))
        saturate(var(--stone-backdrop-saturation));
      --stone-light-body: color-mix(
        in srgb,
        var(--stone-light) var(--stone-body-opacity),
        transparent
      );
      --stone-mid-body: color-mix(
        in srgb,
        var(--stone-mid) var(--stone-body-opacity),
        transparent
      );
      --stone-shadow-body: color-mix(
        in srgb,
        var(--stone-shadow) var(--stone-body-opacity),
        transparent
      );
      --stone-deep-body: color-mix(
        in srgb,
        var(--stone-deep) var(--stone-body-opacity),
        transparent
      );
      --stone-radius: 23px 18px 22px 17px / 19px 23px 18px 22px;
      --stone-radius-flipped: 18px 23px 17px 22px / 23px 19px 22px 18px;
      --stone-texture-flip: 1;
      --stone-texture-counter-flip: -1;
      --stone-origin-x: 50%;
      --stone-origin-y: 50%;
      --stone-tilt-x: 0deg;
      --stone-tilt-y: 0deg;
      --stone-parallax-x: 0px;
      --stone-parallax-y: 0px;
      --stone-press-depth: 0px;
      --stone-press-scale: 1;
      --stone-face-position: 0%;
      --stone-hover-lift: 2.25px;
      --stone-hover-offset: 0px;
      box-sizing: border-box;
      display: inline-block;
      min-width: 0;
      vertical-align: middle;
      -webkit-tap-highlight-color: transparent;
      contain: layout style;
      cursor: pointer;
    }

    :host([variant="obsidian"]) {
      --stone-image: url("/images/ui/materials/stones/obsidian.webp");
      --stone-deep: #070809;
      --stone-shadow: #141518;
      --stone-mid: #33363d;
      --stone-light: #a5acb8;
      --stone-flare: 202 220 244;
      --stone-caustic: 99 115 144;
      --stone-ink: #f3f6fb;
      --stone-ink-highlight: rgb(255 255 255 / 0.24);
      --stone-body-opacity: 60%;
      --stone-mineral-opacity: 0.57;
      --stone-backdrop-blur: 1.1px;
      --stone-backdrop-saturation: 1.16;
      --stone-radius: 18px 24px 17px 22px / 23px 18px 24px 17px;
      --stone-radius-flipped: 24px 18px 22px 17px / 18px 23px 17px 24px;
    }

    :host([variant="amethyst"]) {
      --stone-image: url("/images/ui/materials/stones/amethyst.webp");
      --stone-deep: #230b39;
      --stone-shadow: #39125b;
      --stone-mid: #7546a2;
      --stone-light: #e2c7ff;
      --stone-flare: 244 223 255;
      --stone-caustic: 169 99 239;
      --stone-ink: #fff8ff;
      --stone-ink-highlight: rgb(255 226 255 / 0.3);
      --stone-body-opacity: 88%;
      --stone-mineral-opacity: 0.84;
      --stone-backdrop-blur: 2.2px;
      --stone-backdrop-saturation: 1.3;
      --stone-backdrop-filter: none;
      --stone-radius: 22px 17px 25px 19px / 17px 23px 18px 25px;
      --stone-radius-flipped: 17px 22px 19px 25px / 23px 17px 25px 18px;
    }

    :host([variant="ruby"]) {
      --stone-image: url("/images/ui/materials/stones/ruby.webp");
      --stone-deep: #39070f;
      --stone-shadow: #65111e;
      --stone-mid: #b82b41;
      --stone-light: #ffb7af;
      --stone-flare: 255 226 213;
      --stone-caustic: 255 63 80;
      --stone-ink: #fff8ee;
      --stone-ink-highlight: rgb(255 232 215 / 0.31);
      --stone-body-opacity: 90%;
      --stone-mineral-opacity: 0.86;
      --stone-backdrop-blur: 2.4px;
      --stone-backdrop-saturation: 1.34;
      --stone-backdrop-filter: none;
      --stone-radius: 20px 25px 18px 22px / 23px 19px 25px 18px;
      --stone-radius-flipped: 25px 20px 22px 18px / 19px 23px 18px 25px;
    }

    :host([variant="emerald"]) {
      --stone-image: url("/images/ui/materials/stones/emerald.webp");
      --stone-deep: #052b22;
      --stone-shadow: #07513e;
      --stone-mid: #168d68;
      --stone-light: #a7f4d0;
      --stone-flare: 220 255 235;
      --stone-caustic: 53 231 154;
      --stone-ink: #f4fff9;
      --stone-ink-highlight: rgb(226 255 239 / 0.32);
      --stone-body-opacity: 89%;
      --stone-mineral-opacity: 0.85;
      --stone-backdrop-blur: 2.3px;
      --stone-backdrop-saturation: 1.32;
      --stone-backdrop-filter: none;
      --stone-radius: 25px 19px 22px 17px / 18px 24px 17px 23px;
      --stone-radius-flipped: 19px 25px 17px 22px / 24px 18px 23px 17px;
    }

    :host,
    :host([size="standard"]) {
      --stone-min-height: 51px;
      --stone-padding-block: 8px;
      --stone-padding-inline: 18px;
      --stone-label-size: 0.89rem;
      --stone-detail-size: 0.65rem;
      --stone-icon-size: 1.25rem;
      --stone-gap: 9px;
      --stone-lip: 4px;
    }

    :host([size="compact"]) {
      --stone-min-height: 37px;
      --stone-padding-block: 6px;
      --stone-padding-inline: 13px;
      --stone-label-size: 0.75rem;
      --stone-detail-size: 0.59rem;
      --stone-icon-size: 1rem;
      --stone-gap: 7px;
      --stone-lip: 3px;
      --stone-hover-lift: 1.5px;
    }

    :host([size="hero"]) {
      --stone-min-height: 68px;
      --stone-padding-block: 11px;
      --stone-padding-inline: 27px;
      --stone-label-size: 1.08rem;
      --stone-detail-size: 0.72rem;
      --stone-icon-size: 1.55rem;
      --stone-gap: 12px;
      --stone-lip: 5px;
      --stone-hover-lift: 3px;
      min-width: min(100%, 238px);
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    .assembly {
      position: relative;
      z-index: 0;
      width: 100%;
      padding-bottom: var(--stone-lip);
      perspective: 640px;
      transform-style: preserve-3d;
      cursor: inherit;
    }

    /*
     * The assembly remains a stable rectangular hit target. Auto variation
     * only mirrors the variant's existing, restrained asymmetry—no clipping,
     * rotation, or geometry change that could move its layout or focus ring.
     */
    .assembly[data-mirror="flipped"] {
      --stone-radius: var(--stone-radius-flipped);
      --stone-texture-flip: -1;
      --stone-texture-counter-flip: 1;
    }

    .projection {
      position: absolute;
      z-index: -1;
      top: 64%;
      left: 4%;
      width: 92%;
      height: 72%;
      overflow: hidden;
      border-radius: 45% 52% 48% 38%;
      opacity: 0.16;
      pointer-events: none;
      background:
        radial-gradient(
          ellipse at var(--stone-origin-x) 0%,
          rgb(var(--stone-flare) / 0.55) 0 4%,
          rgb(var(--stone-caustic) / 0.43) 11%,
          transparent 50%
        ),
        repeating-conic-gradient(
          from 31deg at var(--stone-origin-x) 0%,
          transparent 0deg 8deg,
          rgb(var(--stone-caustic) / 0.25) 9deg 13deg,
          transparent 14deg 27deg
        ),
        radial-gradient(
          ellipse at 50% 16%,
          rgb(var(--stone-caustic) / 0.34),
          transparent 68%
        );
      filter: blur(8px) saturate(1.3);
      mix-blend-mode: screen;
      transform: translate3d(
          calc(var(--stone-parallax-x) * -0.34),
          calc(8px + var(--stone-press-depth)),
          -20px
        )
        rotateX(67deg) scaleX(0.94);
      transform-origin: var(--stone-origin-x) 0%;
      transition:
        opacity 320ms cubic-bezier(0.16, 1, 0.3, 1),
        transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1),
        filter 320ms ease;
      -webkit-mask-image: radial-gradient(
        ellipse at 50% 16%,
        #000 0 22%,
        transparent 76%
      );
      mask-image: radial-gradient(
        ellipse at 50% 16%,
        #000 0 22%,
        transparent 76%
      );
    }

    .projection::before {
      position: absolute;
      inset: -34% -16% 2%;
      border-radius: inherit;
      background-image: var(--stone-image);
      background-position: calc(50% + var(--stone-parallax-x))
        calc(8% + var(--stone-parallax-y));
      background-repeat: no-repeat;
      background-size: 190% 230%;
      content: "";
      filter: contrast(1.16) saturate(1.42) blur(1.4px);
      mix-blend-mode: soft-light;
      opacity: 0.38;
      transform: scaleX(var(--stone-texture-flip)) scaleY(1.34) skewX(-7deg);
      transform-origin: var(--stone-origin-x) 0%;
      transition:
        opacity 210ms ease,
        transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }

    .stone-button {
      position: relative;
      z-index: 1;
      display: grid;
      width: 100%;
      min-height: var(--stone-min-height);
      margin: 0;
      padding: var(--stone-padding-block) var(--stone-padding-inline);
      overflow: hidden;
      border: 0;
      border-radius: var(--stone-radius);
      color: var(--stone-ink);
      font: inherit;
      text-align: start;
      touch-action: manipulation;
      cursor: inherit;
      isolation: isolate;
      background: transparent;
      -webkit-backdrop-filter: var(--stone-backdrop-filter);
      backdrop-filter: var(--stone-backdrop-filter);
      box-shadow:
        0 var(--stone-lip) 0 color-mix(in srgb, var(--stone-deep) 82%, #000),
        0 calc(var(--stone-lip) + 5px) 13px rgb(0 0 0 / 0.38),
        0 calc(var(--stone-lip) + 11px) 24px rgb(var(--stone-caustic) / 0.1);
      transform: rotateX(var(--stone-tilt-x)) rotateY(var(--stone-tilt-y))
        translate3d(
          0,
          calc(var(--stone-press-depth) + var(--stone-hover-offset)),
          0
        )
        scale(var(--stone-press-scale));
      transform-origin: var(--stone-origin-x) var(--stone-origin-y);
      transition:
        transform 180ms cubic-bezier(0.18, 0.87, 0.28, 1.16),
        box-shadow 210ms cubic-bezier(0.2, 0.8, 0.2, 1),
        filter 240ms ease;
      will-change: auto;
    }

    /*
     * Keep the optical stack on a dedicated clipped plane. WebKit can leak a
     * transformed/blended child through a rounded parent's overflow edge; a
     * separate masked plane fixes that without clipping the button's physical
     * lip, shadow, or the intentional projection beneath it.
     */
    .face-mask {
      position: absolute;
      z-index: 0;
      inset: 0;
      overflow: hidden;
      overflow: clip;
      border-radius: inherit;
      isolation: isolate;
      pointer-events: none;
      transform: translateZ(0);
      -webkit-mask-image: -webkit-radial-gradient(white, black);
    }

    .base,
    .mineral,
    .marbling,
    .frost,
    .diffraction,
    .ridge,
    .glare,
    .impact {
      position: absolute;
      pointer-events: none;
      border-radius: inherit;
    }

    .base {
      z-index: 0;
      inset: 0;
      background-image:
        radial-gradient(
          ellipse at 48% -5%,
          rgb(var(--stone-flare) / 0.42),
          transparent 48%
        ),
        linear-gradient(
          180deg,
          var(--stone-light-body) 0%,
          var(--stone-mid-body) 8%,
          var(--stone-shadow-body) 23%,
          var(--stone-deep-body) 39%,
          var(--stone-deep-body) 49.75%,
          var(--stone-deep-body) 50.25%,
          var(--stone-shadow-body) 62%,
          var(--stone-mid-body) 77%,
          var(--stone-light-body) 92%,
          var(--stone-light-body) 100%
        );
      background-position:
        center top,
        center var(--stone-face-position);
      background-size:
        100% 100%,
        100% 200%;
      box-shadow:
        inset 0 1px 0 rgb(var(--stone-flare) / 0.92),
        inset 0 -2px 3px rgb(0 0 0 / 0.57),
        inset 3px 0 6px rgb(var(--stone-flare) / 0.13),
        inset -4px 0 8px rgb(0 0 0 / 0.19);
      transition:
        background-position 210ms cubic-bezier(0.2, 0.72, 0.2, 1),
        box-shadow 180ms cubic-bezier(0.2, 0.72, 0.2, 1);
    }

    .mineral {
      z-index: 1;
      inset: 2px;
      background-image:
        var(--stone-image),
        linear-gradient(
          118deg,
          transparent 0 18%,
          rgb(var(--stone-flare) / 0.18) 23%,
          transparent 36% 66%,
          rgb(0 0 0 / 0.22) 73%,
          transparent 84%
        );
      background-position:
        center,
        calc(50% + var(--stone-parallax-x)) calc(50% + var(--stone-parallax-y));
      background-size:
        cover,
        160% 190%;
      background-blend-mode: soft-light, normal;
      filter: contrast(1.08) saturate(1.08);
      opacity: var(--stone-mineral-opacity);
      transform: translate3d(
          calc(var(--stone-parallax-x) * 0.19),
          calc(var(--stone-parallax-y) * 0.19),
          0
        )
        scaleX(var(--stone-texture-flip));
      transition:
        filter 180ms ease,
        opacity 150ms ease;
    }

    .marbling {
      z-index: 2;
      inset: 1px;
      opacity: 0.72;
      background:
        radial-gradient(
          110% 78% at calc(var(--stone-origin-x) + 8%) -8%,
          rgb(var(--stone-flare) / 0.46) 0 5%,
          transparent 31%
        ),
        repeating-radial-gradient(
          ellipse at 19% 128%,
          transparent 0 13px,
          rgb(var(--stone-caustic) / 0.12) 14px 16px,
          transparent 18px 31px
        ),
        linear-gradient(
          103deg,
          transparent 8%,
          rgb(255 255 255 / 0.1) 9%,
          transparent 13% 49%,
          rgb(0 0 0 / 0.12) 50%,
          transparent 54%
        );
      background-size:
        150% 140%,
        132% 180%,
        176% 160%;
      background-position:
        calc(50% + var(--stone-parallax-x)) calc(50% + var(--stone-parallax-y)),
        calc(50% - var(--stone-parallax-x)) 50%,
        center;
      mix-blend-mode: screen;
      transform: translate3d(
        calc(var(--stone-parallax-x) * 0.43),
        calc(var(--stone-parallax-y) * 0.31),
        0
      );
      transition: opacity 150ms ease;
    }

    .marbling::before {
      position: absolute;
      inset: 3% -7%;
      border-radius: inherit;
      background-image: var(--stone-image);
      background-position: calc(50% - var(--stone-parallax-x))
        calc(46% - var(--stone-parallax-y));
      background-repeat: no-repeat;
      background-size: 215% 270%;
      content: "";
      filter: contrast(1.42) saturate(0.82);
      mix-blend-mode: soft-light;
      opacity: 0.3;
      transform: scaleX(var(--stone-texture-counter-flip))
        translate3d(
          calc(var(--stone-parallax-x) * 0.22),
          calc(var(--stone-parallax-y) * -0.18),
          0
        );
    }

    .frost {
      z-index: 3;
      inset: 2px;
      opacity: 0.48;
      background-image:
        repeating-radial-gradient(
          circle at 31% 42%,
          rgb(255 255 255 / 0.08) 0 0.55px,
          transparent 0.8px 2.2px
        ),
        radial-gradient(
          ellipse at 52% 12%,
          rgb(255 255 255 / 0.29),
          transparent 46%
        );
      background-size:
        5px 5px,
        100% 100%;
      mix-blend-mode: soft-light;
      filter: contrast(1.18);
    }

    .diffraction {
      z-index: 4;
      inset: 2px;
      opacity: 0.44;
      background: conic-gradient(
        from 207deg at var(--stone-origin-x) var(--stone-origin-y),
        transparent 0deg,
        rgb(255 87 176 / 0.13) 22deg,
        transparent 43deg,
        rgb(103 203 255 / 0.17) 61deg,
        transparent 91deg,
        rgb(246 241 145 / 0.12) 126deg,
        transparent 166deg 360deg
      );
      mix-blend-mode: screen;
      transform: translate3d(
        calc(var(--stone-parallax-x) * -0.28),
        calc(var(--stone-parallax-y) * -0.24),
        0
      );
      transition: opacity 150ms ease;
    }

    .ridge {
      z-index: 5;
      inset: 0;
      border: 1px solid rgb(var(--stone-flare) / 0.48);
      background: linear-gradient(
          180deg,
          rgb(var(--stone-flare) / 0.94) 0 1px,
          rgb(var(--stone-flare) / 0.38) 2px,
          transparent 6px 70%,
          rgb(0 0 0 / 0.59) calc(100% - 2px),
          rgb(0 0 0 / 0.86) 100%
        )
        border-box;
      box-shadow:
        inset 0 1px 1px rgb(255 255 255 / 0.38),
        inset 0 -1px 0 rgb(0 0 0 / 0.67),
        inset 0 0 0 2px rgb(255 255 255 / 0.07);
    }

    .glare {
      z-index: 6;
      inset: 2px 3px auto;
      height: 57%;
      border-radius: 999px 999px 47% 43% / 80% 80% 28% 32%;
      opacity: 0.86;
      background:
        radial-gradient(
          80% 100% at var(--stone-origin-x) -10%,
          rgb(255 255 255 / 0.87),
          rgb(var(--stone-flare) / 0.24) 43%,
          transparent 72%
        ),
        linear-gradient(
          180deg,
          rgb(255 255 255 / 0.52),
          rgb(255 255 255 / 0.07) 62%,
          transparent
        );
      filter: blur(0.12px);
      mix-blend-mode: screen;
      transform: translate3d(
        calc(var(--stone-parallax-x) * 0.66),
        calc(var(--stone-parallax-y) * 0.44),
        0
      );
      transform-origin: var(--stone-origin-x) var(--stone-origin-y);
      transition:
        height 170ms ease,
        opacity 180ms ease,
        transform 170ms ease;
    }

    .impact {
      z-index: 7;
      inset: -26%;
      opacity: 0;
      background: radial-gradient(
        circle at var(--stone-origin-x) var(--stone-origin-y),
        rgb(255 255 255 / 0.72) 0,
        rgb(var(--stone-flare) / 0.36) 9%,
        rgb(var(--stone-caustic) / 0.18) 19%,
        transparent 43%
      );
      mix-blend-mode: screen;
      transform: scale(0.18);
      transform-origin: var(--stone-origin-x) var(--stone-origin-y);
    }

    .impact[data-impact="a"] {
      animation: stone-impact-a 610ms cubic-bezier(0.1, 0.72, 0.24, 1);
    }

    .impact[data-impact="b"] {
      animation: stone-impact-b 610ms cubic-bezier(0.1, 0.72, 0.24, 1);
    }

    .content {
      position: relative;
      z-index: 3;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      justify-content: center;
      gap: var(--stone-gap);
      min-width: 0;
      transform: translate3d(
        calc(var(--stone-parallax-x) * 0.13),
        calc(var(--stone-parallax-y) * 0.1),
        0
      );
      transition:
        transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
        opacity 180ms ease;
    }

    slot[name="icon"] {
      display: contents;
    }

    slot[name="icon"]::slotted(*) {
      width: var(--stone-icon-size);
      height: var(--stone-icon-size);
      filter: drop-shadow(0 -1px 0 rgb(0 0 0 / 0.48))
        drop-shadow(0 1px 0 rgb(var(--stone-flare) / 0.33));
      transition: transform 160ms cubic-bezier(0.2, 0.8, 0.25, 1.25);
    }

    .copy {
      display: grid;
      min-width: 0;
      line-height: 1.04;
    }

    slot[name="label"] {
      overflow: hidden;
      color: var(--stone-ink);
      font-size: var(--stone-label-size);
      font-weight: 760;
      letter-spacing: 0.015em;
      text-overflow: ellipsis;
      text-shadow:
        0 -1px 0 rgb(0 0 0 / 0.5),
        0 1px 0 var(--stone-ink-highlight);
      white-space: nowrap;
    }

    slot[name="detail"] {
      overflow: hidden;
      color: color-mix(in srgb, var(--stone-ink) 74%, transparent);
      font-size: var(--stone-detail-size);
      font-weight: 650;
      letter-spacing: 0.075em;
      line-height: 1.25;
      text-overflow: ellipsis;
      text-shadow: 0 1px 0 rgb(var(--stone-flare) / 0.2);
      text-transform: uppercase;
      white-space: nowrap;
    }

    .spinner {
      position: absolute;
      z-index: 5;
      top: 50%;
      left: 50%;
      width: calc(var(--stone-icon-size) * 0.94);
      aspect-ratio: 1;
      margin: 0;
      border: 2px solid color-mix(in srgb, var(--stone-ink) 24%, transparent);
      border-top-color: var(--stone-ink);
      border-radius: 50%;
      translate: -50% -50%;
      animation: stone-spin 760ms linear infinite;
    }

    :host(:hover:not([disabled]):not([loading])) .projection,
    :host(:focus-within:not([disabled]):not([loading])) .projection {
      opacity: 0.34;
      filter: blur(7px) saturate(1.58);
    }

    :host(:hover:not([disabled]):not([loading])) .mineral {
      filter: contrast(1.12) saturate(1.18);
    }

    :host(:hover:not([disabled]):not([loading])) .stone-button,
    :host(:focus-within:not([disabled]):not([loading])) .stone-button,
    :host([data-pressed]:not([disabled]):not([loading])) .stone-button {
      will-change: transform;
    }

    :host(
      :hover:not([disabled]):not([loading]):not([pressed="true"]):not(
          [data-pressed]
        )
    ) {
      --stone-hover-offset: calc(var(--stone-hover-lift) * -1);
    }

    /*
     * A toggle remains visibly seated after the pointer is released. It is
     * shallower than the transient press below, so pressing a latched stone
     * still has a final, tactile increment of travel.
     */
    :host([pressed="true"]:not([disabled]):not([loading])) {
      --stone-press-depth: calc(var(--stone-lip) * 0.56);
      --stone-press-scale: 0.998;
      --stone-face-position: 64%;
      --stone-hover-offset: 0px;
    }

    :host([pressed="true"]:not([disabled]):not([loading])) .stone-button {
      box-shadow:
        0 calc(var(--stone-lip) * 0.44) 0
          color-mix(in srgb, var(--stone-deep) 86%, #000),
        0 calc(var(--stone-lip) + 3px) 10px rgb(0 0 0 / 0.35),
        0 calc(var(--stone-lip) + 10px) 25px rgb(var(--stone-caustic) / 0.22);
      filter: saturate(1.08) contrast(1.03);
    }

    :host([pressed="true"]:not([disabled]):not([loading])) .base {
      box-shadow:
        inset 0 2px 5px rgb(0 0 0 / 0.28),
        inset 0 -1px 0 rgb(var(--stone-flare) / 0.66),
        inset 3px 0 5px rgb(var(--stone-flare) / 0.11),
        inset -3px 0 7px rgb(0 0 0 / 0.2);
    }

    :host([pressed="true"]:not([disabled]):not([loading])) .ridge {
      background: linear-gradient(
        0deg,
        rgb(var(--stone-flare) / 0.78) 0 1px,
        transparent 5px 72%,
        rgb(0 0 0 / 0.48) calc(100% - 2px),
        rgb(0 0 0 / 0.7) 100%
      );
      box-shadow:
        inset 0 2px 4px rgb(0 0 0 / 0.3),
        inset 0 -1px 0 rgb(var(--stone-flare) / 0.48),
        inset 0 0 0 2px rgb(var(--stone-caustic) / 0.12);
    }

    :host([pressed="true"]:not([disabled]):not([loading])) .glare {
      height: 52%;
      opacity: 0.54;
      transform: translate3d(0, 34%, 0) scaleY(-0.44);
    }

    :host([pressed="true"]:not([disabled]):not([loading])) .projection {
      opacity: 0.28;
      filter: blur(8px) saturate(1.4);
    }

    :host([pressed="true"]:not([disabled]):not([loading])) .diffraction {
      opacity: 0.48;
    }

    :host([pressed="true"]:not([disabled]):not([loading])) .content {
      transform: translate3d(
        calc(var(--stone-parallax-x) * 0.1),
        calc(1px + var(--stone-parallax-y) * 0.08),
        0
      );
    }

    :host([data-pressed]:not([disabled]):not([loading])) {
      --stone-press-depth: var(--stone-lip);
      --stone-press-scale: 0.995;
      --stone-face-position: 100%;
      --stone-hover-offset: 0px;
    }

    /*
     * Native :active is a Safari-safe first frame. The host attribute keeps
     * the same pose visible after a quick release; this rule means the face
     * still depresses even if pointer capture is delayed or rejected.
     */
    .stone-button:active:not(:disabled) {
      --stone-press-depth: var(--stone-lip);
      --stone-press-scale: 0.995;
      --stone-face-position: 100%;
      --stone-hover-offset: 0px;
      box-shadow:
        inset 0 6px 13px rgb(0 0 0 / 0.44),
        inset 0 1px 0 rgb(0 0 0 / 0.42),
        0 1px 2px rgb(0 0 0 / 0.42);
      filter: brightness(0.92) saturate(1.04);
      transform: translate3d(0, var(--stone-lip), 0) scale(0.985);
      transition-duration: 55ms;
    }

    :host([data-pressed]:not([disabled]):not([loading])) .stone-button {
      box-shadow:
        inset 0 6px 13px rgb(0 0 0 / 0.44),
        inset 0 1px 0 rgb(0 0 0 / 0.42),
        0 1px 2px rgb(0 0 0 / 0.42);
      filter: brightness(0.92) saturate(1.04);
      transform: translate3d(0, var(--stone-lip), 0) scale(0.985);
      transition-duration: 55ms;
    }

    :host([data-pressed]:not([disabled]):not([loading])) .projection {
      opacity: 0.16;
      filter: blur(8px) saturate(1.28);
    }

    :host([data-pressed]:not([disabled]):not([loading])) .projection::before {
      opacity: 0.24;
      transform: scaleX(var(--stone-texture-flip)) scaleY(1.12) skewX(-2deg);
    }

    :host([data-pressed]:not([disabled]):not([loading])) .base {
      box-shadow:
        inset 0 -1px 0 rgb(var(--stone-flare) / 0.72),
        inset 0 3px 7px rgb(0 0 0 / 0.52),
        inset 3px 0 5px rgb(var(--stone-flare) / 0.09),
        inset -3px 0 6px rgb(0 0 0 / 0.18);
      transition-duration: 65ms;
    }

    .stone-button:active:not(:disabled) .base {
      box-shadow:
        inset 0 -1px 0 rgb(var(--stone-flare) / 0.72),
        inset 0 3px 7px rgb(0 0 0 / 0.52),
        inset 3px 0 5px rgb(var(--stone-flare) / 0.09),
        inset -3px 0 6px rgb(0 0 0 / 0.18);
      transition-duration: 65ms;
    }

    :host([data-pressed]:not([disabled]):not([loading])) .ridge {
      background: linear-gradient(
        0deg,
        rgb(var(--stone-flare) / 0.69) 0 1px,
        transparent 5px 76%,
        rgb(0 0 0 / 0.68) calc(100% - 2px),
        rgb(0 0 0 / 0.83) 100%
      );
      box-shadow:
        inset 0 3px 6px rgb(0 0 0 / 0.43),
        inset 0 -1px 0 rgb(var(--stone-flare) / 0.42);
    }

    :host([data-pressed]:not([disabled]):not([loading])) .glare {
      height: 57%;
      opacity: 0.52;
      transform: translate3d(0, 58%, 0) scaleY(-0.76);
      transition-duration: 70ms;
    }

    .stone-button:active:not(:disabled) .glare {
      height: 57%;
      opacity: 0.52;
      transform: translate3d(0, 58%, 0) scaleY(-0.76);
      transition-duration: 70ms;
    }

    :host([data-pressed]:not([disabled]):not([loading])) .content {
      transform: translate3d(0, 1px, 0) scale(0.99);
      transition-duration: 55ms;
    }

    :host([data-pressed]:not([disabled]):not([loading])) .mineral {
      opacity: calc(var(--stone-mineral-opacity) * 0.78);
    }

    :host([data-pressed]:not([disabled]):not([loading])) .marbling {
      opacity: 0.5;
    }

    :host([data-pressed]:not([disabled]):not([loading])) .diffraction {
      opacity: 0.28;
    }

    :host([data-pressed]:not([disabled]):not([loading]))
      slot[name="icon"]::slotted(*) {
      transform: translateY(1px) scale(0.96);
    }

    .stone-button:focus-visible {
      outline: 3px solid rgb(var(--stone-flare) / 0.91);
      outline-offset: 4px;
      box-shadow:
        0 var(--stone-lip) 0 color-mix(in srgb, var(--stone-deep) 82%, #000),
        0 calc(var(--stone-lip) + 5px) 13px rgb(0 0 0 / 0.38),
        0 0 0 6px rgb(var(--stone-caustic) / 0.4);
    }

    :host([loading]) .content {
      opacity: 0.22;
    }

    :host([disabled]),
    :host([loading]) {
      cursor: not-allowed;
    }

    :host([disabled]) .stone-button,
    :host([loading]) .stone-button {
      cursor: not-allowed;
      filter: grayscale(0.38) saturate(0.42) brightness(0.76);
      box-shadow:
        0 2px 0 color-mix(in srgb, var(--stone-deep) 72%, #000),
        0 5px 9px rgb(0 0 0 / 0.25);
      transform: none;
    }

    :host([disabled]) .projection,
    :host([loading]) .projection {
      opacity: 0.05;
    }

    @keyframes stone-impact-a {
      0% {
        opacity: 0.88;
        transform: scale(0.16);
      }
      58% {
        opacity: 0.38;
      }
      100% {
        opacity: 0;
        transform: scale(1.62);
      }
    }

    @keyframes stone-impact-b {
      0% {
        opacity: 0.88;
        transform: scale(0.16);
      }
      58% {
        opacity: 0.38;
      }
      100% {
        opacity: 0;
        transform: scale(1.62);
      }
    }

    @keyframes stone-spin {
      to {
        rotate: 1turn;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .stone-button,
      .projection,
      .content,
      .glare {
        transition-duration: 0.01ms !important;
      }

      .impact,
      .spinner {
        animation: none !important;
      }

      .stone-button {
        transform: translateY(var(--stone-press-depth));
      }
    }

    @media (forced-colors: active) {
      :host {
        forced-color-adjust: auto;
      }

      .stone-button {
        border: 2px solid ButtonText;
        color: ButtonText;
        background: ButtonFace;
        box-shadow: 0 var(--stone-lip) 0 ButtonText;
      }

      .base,
      .mineral,
      .marbling,
      .frost,
      .diffraction,
      .ridge,
      .glare,
      .impact,
      .projection {
        display: none;
      }

      .stone-button:focus-visible {
        outline: 3px solid Highlight;
      }

      :host([pressed="true"]) .stone-button {
        outline: 2px solid Highlight;
        outline-offset: -5px;
      }

      slot[name="label"],
      slot[name="detail"] {
        color: ButtonText;
        text-shadow: none;
      }

      .spinner {
        border-color: ButtonText;
        border-top-color: Highlight;
      }
    }
  `;

  disconnectedCallback(): void {
    this.clearPressImmediately();
    super.disconnectedCallback();
  }

  private get control(): HTMLButtonElement | null {
    return this.renderRoot.querySelector<HTMLButtonElement>("button");
  }

  private isInactive(): boolean {
    return this.disabled || this.loading;
  }

  private autoShapeKey(): string {
    const explicitKey = this.shapeKey.trim();
    if (explicitKey) return explicitKey;

    // Normalize authoring whitespace so indentation and line wrapping do not
    // unexpectedly reorient a stone. The remaining fallbacks give icon-only
    // controls a stable identity without inventing per-render randomness.
    const content = (this.textContent ?? "").trim().replace(/\s+/g, " ");
    if (content) return content;
    if (this.accessibleLabel.trim()) return this.accessibleLabel.trim();
    if (this.name || this.value) return `${this.name}\u001f${this.value}`;
    return `${this.size}\u001fstone`;
  }

  private resolvedMirror(): Exclude<StoneButtonMirror, "auto"> {
    if (this.mirror === "normal" || this.mirror === "flipped") {
      return this.mirror;
    }
    return stoneButtonMirrorFor(this.variant, this.autoShapeKey());
  }

  private pointFor(
    clientX: number,
    clientY: number,
  ): {
    x: number;
    y: number;
    normalizedX: number;
    normalizedY: number;
  } {
    const rect = this.control?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { x: 50, y: 50, normalizedX: 0.5, normalizedY: 0.5 };
    }
    const normalizedX = Math.min(
      1,
      Math.max(0, (clientX - rect.left) / rect.width),
    );
    const normalizedY = Math.min(
      1,
      Math.max(0, (clientY - rect.top) / rect.height),
    );
    return {
      x: normalizedX * 100,
      y: normalizedY * 100,
      normalizedX,
      normalizedY,
    };
  }

  private setOrigin(clientX: number, clientY: number): void {
    const point = this.pointFor(clientX, clientY);
    this.style.setProperty("--stone-origin-x", `${point.x.toFixed(2)}%`);
    this.style.setProperty("--stone-origin-y", `${point.y.toFixed(2)}%`);
  }

  private queueParallax(clientX: number, clientY: number): void {
    this.pendingPointer = { clientX, clientY };
    if (this.pointerFrame !== undefined) return;
    this.pointerFrame = requestAnimationFrame(() => {
      this.pointerFrame = undefined;
      const pending = this.pendingPointer;
      this.pendingPointer = undefined;
      if (!pending || !this.isConnected || this.isInactive()) return;
      const point = this.pointFor(pending.clientX, pending.clientY);
      const horizontal = point.normalizedX - 0.5;
      const vertical = point.normalizedY - 0.5;
      this.style.setProperty(
        "--stone-tilt-x",
        `${(-vertical * 4.2).toFixed(3)}deg`,
      );
      this.style.setProperty(
        "--stone-tilt-y",
        `${(horizontal * 5.4).toFixed(3)}deg`,
      );
      this.style.setProperty(
        "--stone-parallax-x",
        `${(horizontal * 5.2).toFixed(3)}px`,
      );
      this.style.setProperty(
        "--stone-parallax-y",
        `${(vertical * 3.8).toFixed(3)}px`,
      );
    });
  }

  private cancelPointerFrame(): void {
    if (this.pointerFrame !== undefined) {
      cancelAnimationFrame(this.pointerFrame);
      this.pointerFrame = undefined;
    }
    this.pendingPointer = undefined;
  }

  private settleParallax(): void {
    this.cancelPointerFrame();
    this.style.setProperty("--stone-tilt-x", "0deg");
    this.style.setProperty("--stone-tilt-y", "0deg");
    this.style.setProperty("--stone-parallax-x", "0px");
    this.style.setProperty("--stone-parallax-y", "0px");
  }

  private clearPressReleaseTimer(): void {
    if (this.pressReleaseTimer === undefined) return;
    window.clearTimeout(this.pressReleaseTimer);
    this.pressReleaseTimer = undefined;
  }

  private clearPressImmediately(): void {
    this.clearPressReleaseTimer();
    this.activePointerId = undefined;
    this.pressStartedAt = 0;
    this.removeAttribute("data-pressed");
    this.settleParallax();
  }

  private schedulePressRelease(): void {
    if (!this.hasAttribute("data-pressed")) return;
    this.clearPressReleaseTimer();
    const elapsed = performance.now() - this.pressStartedAt;
    // Browser-driven and trackpad clicks may spend most of the total dwell in
    // event dispatch. Preserve one complete down-transition after release so
    // the stone always reaches its lip before rebounding.
    const remaining = Math.max(
      MINIMUM_POST_RELEASE_PRESS_MS,
      MINIMUM_STONE_PRESS_MS - elapsed,
    );
    if (remaining === 0) {
      this.clearPressImmediately();
      return;
    }
    this.pressReleaseTimer = window.setTimeout(
      () => this.clearPressImmediately(),
      remaining,
    );
  }

  private triggerImpact(): void {
    const impact = this.renderRoot.querySelector<HTMLElement>(".impact");
    if (!impact) return;
    this.impactPhase = !this.impactPhase;
    impact.dataset.impact = this.impactPhase ? "a" : "b";
  }

  private handlePointerDown(event: PointerEvent): void {
    if (this.isInactive()) return;
    this.clearPressReleaseTimer();
    this.activePointerId = event.pointerId;
    this.setOrigin(event.clientX, event.clientY);
    this.settleParallax();
    this.setAttribute("data-pressed", "");
    this.pressStartedAt = performance.now();
    this.triggerImpact();
    const control = event.currentTarget as HTMLButtonElement;
    try {
      control.setPointerCapture?.(event.pointerId);
    } catch {
      // Safari may reject capture if the pointer has already ended.
    }
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.isInactive() || this.hasAttribute("data-pressed")) return;
    this.queueParallax(event.clientX, event.clientY);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (
      this.activePointerId !== undefined &&
      event.pointerId !== this.activePointerId
    ) {
      return;
    }
    this.activePointerId = undefined;
    this.schedulePressRelease();
  }

  private handlePointerCancel(event: PointerEvent): void {
    if (
      this.activePointerId !== undefined &&
      event.pointerId !== this.activePointerId
    ) {
      return;
    }
    this.clearPressImmediately();
  }

  private handlePointerLeave(): void {
    if (this.hasAttribute("data-pressed")) return;
    this.settleParallax();
  }

  private handleLostPointerCapture(event: PointerEvent): void {
    if (
      this.activePointerId !== undefined &&
      event.pointerId !== this.activePointerId
    ) {
      return;
    }
    if (event.buttons === 0) this.schedulePressRelease();
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (this.isInactive() || (event.key !== " " && event.key !== "Enter")) {
      return;
    }
    if (this.hasAttribute("data-pressed")) return;
    this.clearPressReleaseTimer();
    const rect = this.control?.getBoundingClientRect();
    if (rect) {
      this.setOrigin(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
    this.settleParallax();
    this.setAttribute("data-pressed", "");
    this.pressStartedAt = performance.now();
    if (!event.repeat) this.triggerImpact();
  }

  private handleKeyUp(event: KeyboardEvent): void {
    if (event.key === " " || event.key === "Enter") {
      this.schedulePressRelease();
    }
  }

  private handleClick(): void {
    if (this.isInactive() || this.pressed === undefined) return;
    this.dispatchEvent(
      new CustomEvent<StoneToggleRequestDetail>("stone-toggle-request", {
        bubbles: true,
        composed: true,
        detail: { pressed: !this.pressed },
      }),
    );
  }

  render() {
    const inactive = this.isInactive();
    const resolvedMirror = this.resolvedMirror();
    return html`
      <div
        class="assembly"
        data-mirror=${resolvedMirror}
        @pointermove=${this.handlePointerMove}
        @pointerleave=${this.handlePointerLeave}
      >
        <span class="projection" part="projection" aria-hidden="true"></span>
        <button
          class="stone-button"
          part="button"
          type=${this.type}
          name=${this.name || nothing}
          value=${this.value || nothing}
          aria-label=${this.accessibleLabel || nothing}
          aria-busy=${this.loading ? "true" : nothing}
          aria-disabled=${inactive ? "true" : nothing}
          aria-pressed=${
            this.pressed === undefined ? nothing : String(this.pressed)
          }
          ?disabled=${inactive}
          @pointerdown=${this.handlePointerDown}
          @pointerup=${this.handlePointerUp}
          @pointercancel=${this.handlePointerCancel}
          @lostpointercapture=${this.handleLostPointerCapture}
          @keydown=${this.handleKeyDown}
          @keyup=${this.handleKeyUp}
          @blur=${this.clearPressImmediately}
          @click=${this.handleClick}
        >
          <span class="face-mask" aria-hidden="true">
            <span class="base"></span>
            <span class="mineral"></span>
            <span class="marbling"></span>
            <span class="frost"></span>
            <span class="diffraction"></span>
            <span class="ridge"></span>
            <span class="glare"></span>
            <span class="impact"></span>
          </span>
          ${
            this.loading
              ? html`<span class="spinner" aria-hidden="true"></span>`
              : nothing
          }
          <span class="content" part="content">
            <slot name="icon"></slot>
            <span class="copy">
              <slot name="label"><slot></slot></slot>
              <slot name="detail"></slot>
            </span>
          </span>
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "idlefront-stone-button": IdlefrontStoneButton;
  }
}
