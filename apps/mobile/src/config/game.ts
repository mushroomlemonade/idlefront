import { Dimensions, PixelRatio, Platform } from "react-native";

const LAN_GAME_URL = "http://192.168.2.118:9000/";

function normalizeGameUrl(value: string | undefined): string {
  const configured = value?.trim();
  const candidate = configured?.length ? configured : LAN_GAME_URL;
  const match = /^(.*?)([?#].*)?$/.exec(candidate);
  const path = match?.[1] ?? candidate;
  const suffix = match?.[2] ?? "";
  return `${path.endsWith("/") ? path : `${path}/`}${suffix}`;
}

export const GAME_URL = normalizeGameUrl(process.env.EXPO_PUBLIC_GAME_URL);

export const NATIVE_BRIDGE_BOOTSTRAP = `
  (function () {
    var lockViewport = function () {
      if (!document.head) return;
      var viewport = document.querySelector('meta[name="viewport"]');
      if (!viewport) {
        viewport = document.createElement("meta");
        viewport.setAttribute("name", "viewport");
        document.head.appendChild(viewport);
      }
      viewport.setAttribute(
        "content",
        "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
      );
    };
    lockViewport();
    document.addEventListener("DOMContentLoaded", lockViewport, { once: true });

    // WebGL events do not bubble. Capture them at the document so the native
    // console can distinguish GPU-context loss from a terminated WebContent
    // process. No URL, player identity, or gameplay data crosses this bridge.
    ["webglcontextlost", "webglcontextrestored"].forEach(function (name) {
      document.addEventListener(name, function () {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: name === "webglcontextlost" ? "idlefront:webgl-lost" : "idlefront:webgl-restored"
        }));
      }, true);
    });

    var detail = {
      platform: ${JSON.stringify(Platform.OS)},
      shellVersion: "0.1.0",
      capabilities: ["app-state", "haptics", "persistent-session", "configurable-frame-rate"]
    };
    window.__PRESSURE_ATLAS_NATIVE__ = detail;
    window.__IDLEFRONT_NATIVE__ = detail;
    window.dispatchEvent(new CustomEvent("pressureatlas:native-ready", { detail: detail }));
  })();
  true;
`;

export function appStateScript(state: string): string {
  return `
    window.dispatchEvent(new CustomEvent("pressureatlas:app-state", {
      detail: { state: ${JSON.stringify(state)} }
    }));
    true;
  `;
}

export function safeAreaScript(
  top: number,
  right: number,
  bottom: number,
  left: number,
): string {
  const screen = Dimensions.get("screen");
  const windowSize = Dimensions.get("window");
  const metrics = {
    platform: Platform.OS,
    osVersion: Platform.Version,
    screen: { width: screen.width, height: screen.height },
    window: { width: windowSize.width, height: windowSize.height },
    pixelRatio: PixelRatio.get(),
    fontScale: PixelRatio.getFontScale(),
    insets: { top, right, bottom, left },
  };
  return `
    (function () {
      var root = document.documentElement;
      if (!root) return;
      window.__IDLEFRONT_DISPLAY_METRICS__ = ${JSON.stringify(metrics)};
      root.style.setProperty("--native-safe-top", ${JSON.stringify(`${top}px`)});
      root.style.setProperty("--native-safe-right", ${JSON.stringify(`${right}px`)});
      root.style.setProperty("--native-safe-bottom", ${JSON.stringify(`${bottom}px`)});
      root.style.setProperty("--native-safe-left", ${JSON.stringify(`${left}px`)});
    })();
    true;
  `;
}
