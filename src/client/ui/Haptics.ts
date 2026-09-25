export type HapticPattern =
  | "selection"
  | "light"
  | "medium"
  | "heavy"
  | "success"
  | "warning"
  | "error"
  | "nuke"
  | "alert";

interface NativeWebViewBridge {
  postMessage(message: string): void;
}

declare global {
  interface Window {
    ReactNativeWebView?: NativeWebViewBridge;
  }
}

const webPatterns: Record<HapticPattern, number | number[]> = {
  selection: 7,
  light: 10,
  medium: 16,
  heavy: 24,
  success: [10, 38, 16],
  warning: [18, 44, 18],
  error: [24, 36, 24],
  nuke: [28, 45, 18],
  alert: [20, 55, 20, 55, 28],
};

/** Sends semantic feedback to the native shell, with an Android/web fallback. */
export function requestHaptic(pattern: HapticPattern = "selection"): void {
  try {
    if (window.ReactNativeWebView?.postMessage) {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: "idlefront:haptic", pattern }),
      );
      return;
    }
  } catch {
    // A stale WebView bridge should never prevent its control from activating.
  }

  try {
    navigator.vibrate?.(webPatterns[pattern]);
  } catch {
    // Vibration is optional and may be blocked by the browser or OS settings.
  }
}

function inferredPattern(control: HTMLElement): HapticPattern {
  const explicit = control.dataset.haptic as HapticPattern | undefined;
  if (explicit) return explicit;
  if (
    control.matches(
      ".pw-button--danger, .atlas-danger-button, [aria-haspopup='alertdialog']",
    )
  ) {
    return "warning";
  }
  if (
    control.matches(
      ".atlas-quick-play, .pw-button--primary, .start-game-button",
    )
  ) {
    return "medium";
  }
  return "selection";
}

/** One delegated listener covers Lit, light-DOM, and inherited game buttons. */
export class UiHapticController {
  constructor(private readonly root: Document = document) {
    root.addEventListener("click", this.onClick, { capture: true });
  }

  dispose(): void {
    this.root.removeEventListener("click", this.onClick, { capture: true });
  }

  private onClick = (event: MouseEvent): void => {
    const control = event
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement &&
          node.matches(
            "button:not(:disabled), [role='button']:not([aria-disabled='true']), input[type='checkbox']:not(:disabled), input[type='radio']:not(:disabled)",
          ),
      );
    if (!control || control.dataset.haptic === "none") return;
    requestHaptic(inferredPattern(control));
  };
}
