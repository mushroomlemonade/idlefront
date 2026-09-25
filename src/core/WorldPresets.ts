import { GameMapType } from "./game/Game";

export const WORLD_PRESETS = {
  quickplay: {
    label: "quickplay",
    map: GameMapType.GiantWorldMap,
    duration: "1h",
    scale: 1,
    allianceProtectionMinutes: 5,
    pressureGraceSeconds: 180,
    trade: 1,
    trains: 1,
    attackDivisor: 1,
  },
  longplay: {
    label: "longplay",
    map: GameMapType.ExpandedGiantWorldLargeHDv1,
    duration: "1d",
    scale: 9,
    allianceProtectionMinutes: 30,
    pressureGraceSeconds: 1200,
    trade: 1,
    trains: 1,
    attackDivisor: 1,
  },
  idlefront: {
    label: "idlefront",
    map: GameMapType.PixelEarth27v1,
    duration: "7d",
    scale: 27,
    allianceProtectionMinutes: 720,
    pressureGraceSeconds: 3600,
    trade: 1,
    trains: 1,
    attackDivisor: 1,
  },
  // Keep historical identifiers readable for saved worlds and replay configs.
  "fog-earth-27x": {
    label: "Discovery Earth · 27× (v0.2 preview)",
    map: GameMapType.PixelEarth27v1,
    trade: 5,
    trains: 5,
    attackDivisor: 1,
    fog: "v0.2",
  },
  "pixel-earth-27x": {
    label: "Pixel Earth · 27× (experimental)",
    map: GameMapType.PixelEarth27v1,
    trade: 5,
    trains: 5,
    attackDivisor: 1,
  },
  "uhd-earth-27x": {
    label: "UHD Earth · 27× (experimental)",
    map: GameMapType.ExpandedGiantWorldUHD27v1,
    trade: 5,
    trains: 5,
    attackDivisor: 1,
  },
  "scheduled-earth": {
    label: "Enormous Earth · 4×",
    map: GameMapType.ExpandedGiantWorld,
    trade: 1,
    trains: 1,
    attackDivisor: 1,
  },
  "great-lakes": {
    label: "Great Lakes",
    map: GameMapType.GreatLakes,
    trade: 10,
    trains: 10,
    attackDivisor: 1,
  },
  "enormous-earth": {
    label: "Enormous Earth · 16×",
    map: GameMapType.ExpandedGiantWorldUltra,
    trade: 5,
    trains: 5,
    attackDivisor: 1,
  },
  "hd-earth-9x": {
    label: "HD Earth · 9×",
    map: GameMapType.ExpandedGiantWorldLargeHDv1,
    trade: 5,
    trains: 5,
    attackDivisor: 1,
  },
} as const;

export type WorldPreset = keyof typeof WORLD_PRESETS;
export const CUSTOM_WORLD_PRESETS = [
  "quickplay",
  "longplay",
  "idlefront",
] as const;

export type CurrentWorldPreset = (typeof CUSTOM_WORLD_PRESETS)[number];
export function isCurrentWorldPreset(
  id: string | null | undefined,
): id is CurrentWorldPreset {
  return id === "quickplay" || id === "longplay" || id === "idlefront";
}
export function presetForDuration(
  duration: "1h" | "1d" | "7d",
): CurrentWorldPreset {
  return { "1h": "quickplay", "1d": "longplay", "7d": "idlefront" }[
    duration
  ] as CurrentWorldPreset;
}
