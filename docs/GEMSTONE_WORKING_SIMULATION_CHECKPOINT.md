# Gemstone working-simulation checkpoint

This document names the repository recovery point tagged
`gemstone-working-simulation-2026-09-07`.

## What is known to work

- Dedicated authoritative simulation workers preserve the current OpenFront
  rules while browser and Expo clients consume server view packets.
- A large Great Lakes session can recover from its durable turn journal and a
  player can resume the same live game.
- Compact server-issued motion plans replace per-unit, per-tick position JSON.
  The reference late-game session fell from roughly 9–10 MB to 0.2–0.4 MB per
  tick and returned to sustained real-time TPS on the development host.
- Initial and reconnect snapshots use bounded, acknowledged delivery so mobile
  input and painting are not starved by one enormous frame.
- Server recovery now reports real completed turns, percentage and an estimated
  remaining time. The recovery surface stays visible until the first live map
  view arrives.
- The Gemstone HUD and material-map rendering state in this commit are part of
  the checkpoint, even though a later UI refactor is planned.

## Validation at the checkpoint

- TypeScript typecheck
- Development production-shaped Vite build
- Simulation host/recovery, protocol, view transport, snapshot compression,
  persistent-world bridge, map-material and trade-scale tests
- Desktop and phone-size visual inspection of the recovery progress surface

## Known follow-up (do not confuse with simulation death)

The lobby can currently label a returning player as eliminated after the
elimination announcement has fired even when the authoritative player still
owns territory. The next pass must distinguish an **elimination announcement /
major GDP and structure loss** from actual death. If even one owned tile remains,
the player must be allowed to resume and continue playing.

## Restoring this point

Create a new branch from `gemstone-working-simulation-2026-09-07`. Do not move
`main` backward or rewrite shared history merely to inspect the checkpoint.
