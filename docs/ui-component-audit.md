# Pressure Atlas UI component audit

## Outcome

The root HTML previously mounted 52 distinct custom elements and repeated page
and HUD layout policy directly in `index.html`. The root now mounts eight
orchestration or shell elements. Original OpenFront controllers remain intact
behind the new light-DOM composition components, so canonical IDs, tag names,
events, and `document.querySelector` integration points continue to work.

| Root mount              | Responsibility                                       | Audit decision                                                      |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| `atlas-game-hud`        | All canonical OpenFront HUD controllers and overlays | New reusable composition; no simulation or renderer ownership       |
| `atlas-global-overlays` | Enforcement, consent, and account-link overlays      | New reusable global composition                                     |
| `atlas-map-bezel`       | Noninteractive precision edge around the viewport    | New primitive; remains a sibling of `#app`                          |
| `atlas-page-deck`       | All non-game destination/modal mounts                | New reusable composition with canonical page IDs                    |
| `desktop-nav-bar`       | Minimal desktop game bar                             | Rebuilt with `atlas-nav-item` and `atlas-status-lamp`               |
| `mobile-nav-bar`        | Responsive destination drawer                        | Rebuilt as a fixed, non-scrolling two-column game menu              |
| `main-layout`           | Single-viewport stage                                | Scrolling removed; individual modal bodies own intentional overflow |
| `play-page`             | Title screen and match entry                         | Rebuilt as one minimal command surface with no marketing sections   |

## Reusable primitive coverage

- `atlas-surface`: material and elevation compositor.
- `atlas-nav-item`: translated canonical page routing and attention state.
- `atlas-status-lamp`: translated live-service state.
- `atlas-gauge`: accessible instrument display.
- `atlas-map-bezel`: pointer-transparent renderer boundary.
- `o-button`: shared tactile button variants and sizes.
- `o-modal`: shared modal shell, sections, tabs, scrim, and presentation
  animation.

## Scrolling policy

- The title screen, navigation drawer, root page stage, and gameplay viewport do
  not scroll.
- Public game choices recompose within the fixed title screen.
- Compact portrait, landscape, and desktop layouts must fit without document or
  stage overflow.
- Long settings, inventory, leaderboard, store, help, and profile content may
  scroll only inside the component-owned modal body where the scrollbar is an
  explicit part of that interaction.

## Protected boundary

`#app`, canvas output, `map-display`, `src/core`, `src/client/render`, camera,
sampling, palette, game input, and simulation remain outside the UI component
system. `atlas-game-hud` only supplies the same controller hosts previously
present in `index.html`.
