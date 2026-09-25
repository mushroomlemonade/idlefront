# IdleFront mobile shell

This Expo app presents the existing IdleFront client as a
full-screen game surface. The map, WebGL renderer, networking, and gameplay stay
in the web application. The React Native shell supplies app lifecycle, session
persistence, safe-area data, platform back navigation, and connection recovery.

The boundary is deliberate: every product screen owns its own controls and
fills the display. The native shell adds no persistent menu, trigger, header,
or control overlay. There is no page-like outer scrolling.

The app icon was generated specifically for Pressure Atlas with the built-in
image generation workflow: an original brass compass over an emerald globe in
a mahogany instrument bezel. Its project master is
`assets/pressure-atlas-icon.png`.

## Run on a phone now

1. Keep the IdleFront web development server running on port `9000`.
2. Copy `.env.example` to `.env.local` if the workstation IP has changed, then
   update `EXPO_PUBLIC_GAME_URL`.
3. From the repository root, run `npm run mobile:start`.
4. Open the resulting QR code with Expo Go on iOS or Android.

The project targets Expo SDK 57 / React Native 0.86. Update the App Store or
Google Play version of Expo Go to SDK 57. Expo Go 57 also requires signing in
to an Expo account. Dependency alignment, TypeScript and an iOS bundle export
were verified on 2026-09-05; an on-device run is still required.

For an off-LAN Metro link, run `npm run start:tunnel` in `apps/mobile` and use
the actual `exp://` URL it prints. The web HTTPS URL is not an Expo manifest.
The native wrapper and web game require two reachable endpoints: Metro serves
the native shell, while `EXPO_PUBLIC_GAME_URL` serves the game itself.

The committed fallback is `http://192.168.2.118:9000/`. For off-LAN testing,
set `EXPO_PUBLIC_GAME_URL=https://atlas-dev.sightings.today/` before starting
Metro. Cloudflare Access can authenticate inside the persistent WebView.

## Architecture contract

- The WebView is full bleed, disables bounce/overscroll, and retains cookies,
  DOM storage, and cache between launches.
- App foreground/background transitions are delivered to the web client as the
  `pressureatlas:app-state` browser event.
- The presence of the shell is delivered as `pressureatlas:native-ready`; the
  same metadata is exposed at `window.__PRESSURE_ATLAS_NATIVE__`.
- Existing gameplay input is never intercepted by persistent native chrome.
- iOS uses its edge-swipe navigation gesture; Android uses its hardware/system
  back action. Reconnect appears only on a connection failure.

## Development builds and literal platform controls

The project includes `expo-dev-client` and an EAS development profile. Future
native controls should be placed in the screen or workflow they operate rather
than collected in global shell chrome.

Create those installable development builds with:

```sh
npx eas-cli build --profile development --platform ios
npx eas-cli build --profile development --platform android
```

iOS cloud builds require the owner's Expo and Apple developer authentication;
Android builds require Expo authentication and signing credentials. No account
or signing identity is committed to this repository.

Before a store release, change the production URL to the final HTTPS game
domain and remove the two cleartext-development exceptions from `app.json`.

## Verification

```sh
npm run typecheck
npx expo-doctor
npx expo export --platform android
```
