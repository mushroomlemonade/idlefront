# Longplay delivery and memory pass — 2026-09-27

## Scope and prior work

The earlier four performance workstreams were implemented, tested, and deployed.
The eight-hour 10-TPS endurance gate was not completed. No claim of sustained
overnight reliability is made here.

New preview longplays use 3,000 bots rather than 16,000. Quickplay/idlefront
presets are unchanged. Persisted worlds retain their original configuration.
Nation strategy v2 and patrol scheduling v1 remain enabled.

## Changes

- Lossless column-oriented Float64 pressure table replaces repeated population
  JSON objects on the wire. Omitted versus explicitly cleared fields, boolean
  settings, and full number precision survive. Unknown future fields use the
  legacy representation. Canonical simulation/replay updates are unchanged.
- Transport envelope v2: updated decoder also accepts v1. Existing clients must
  reload when the preview backend updates; old clients cannot decode v2.
- A 3,000-bot roster plus reserved nations/humans fits 12-bit owner IDs. Allocate
  legacy-width map buffers and 4,096-entry palettes instead of the 65,536-entry
  stress-test palettes. Existing 16,000-bot replays retain wide storage. Never
  truncate IDs. This reduces allocations, not map resolution or game rules.

## Measurement

WebSocket per-message deflate was already enabled. The previously reported
4.7 MB frames were **uncompressed application bytes**, not measured network
traffic. At ten such ticks/second this is 47 MB/s = 376 Mbps *before compression*.
The 16,000-bot simulation also missed its budget with zero connected viewers.

`scripts/benchmark-view-payload.ts` ran a generated 430-tick workload on the real
12324×5844 map, cloning the latest test's longplay configuration with 3,000 bots,
strategic nations v2, and no human inputs. No active match competed with it.
The exact same decoded game update was encoded with both transports.

| Tick | Legacy raw | Compact raw | Legacy deflate | Compact deflate |
| --- | ---: | ---: | ---: | ---: |
| 400 | 834,864 B | 410,424 B | 129,927 B | 120,231 B |
| 430 | 842,152 B | 417,720 B | 139,707 B | 128,289 B |

Tick 430: raw bytes reduced 50.4%, deflated bytes reduced 8.2%. Ten-iteration
Node decode samples averaged 3.95 ms legacy / 1.79 ms compact. These are not
iPhone results. Compression is a deflate estimate without WebSocket/TLS framing,
not measured socket traffic. At 10 TPS the sampled compact deflate rate would
still be about 1.28 MB/s (10.3 Mbps): further delivery work remains worthwhile.

Post-spawn ticks 301–430: median 48.76 ms, p95 76.02 ms. This measures compute
headroom, not wall-clock delivery TPS, mature naval load, or eight-hour health.
Do not compare the early 3000-bot result to mature 16000-bot play as an isolated
codec speedup. Startup with a human and the full spawn window needs playtesting.

## Verification and next gate

Focused protocol, recovery, compaction, identity-width, and runtime-preset tests;
TypeScript, ESLint, and production build. Build retains existing asset/chunk
warnings. Mobile memory and hardware rendering have not been measured here.

Next: create a normal new longplay in Expo, verify spawn/pan/zoom and rejoin,
then collect a mature eight-hour run: 10 TPS, p95 <100 ms, bounded clock debt,
bounded client memory, and reconnect success. Further work should measure actual
compressed socket traffic and profile redundant unchanged player/name updates
before adding visibility subscriptions or less frequent summary channels.
