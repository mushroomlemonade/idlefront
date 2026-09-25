# Larger development-machine playtest

## Scope

The user approved removing the forced 170-minute ending for long playtests,
but not changing normal conquest victory, combat, structures, economy or AI.
The session will run through `atlas-dev.sightings.today` on this development
machine, not on the production machine with four-hour restarts. No automatic
restart is to be performed while the user is playing.

The long quick-start checkbox creates an existing one-day world. It permits a
roughly 12-hour test without inventing a new pacing multiplier or a guaranteed
12-hour game: ordinary conquest and elimination can still end participation
earlier. Short quick starts continue to create one-hour worlds.

## Scale and asset safety

`ExpandedGiantWorldLarge` / **Expanded Earth XL** is a separately versioned map:
12,324 × 5,844 = **72,021,456 tiles**, 78 clipped 1,024-tile pages.
It is 3× Giant Earth's width and height, or **2.25× the current Expanded Earth
area**. It remains one continuous game with the same global tile addresses.

The generator now supports isolated experimental roots and constructs correctly
sized half/quarter-resolution navigation maps for non-2× scales. A 3× map cannot
reuse the 2× map's half-resolution asset. Water/impassable/land downsampling
priority follows the existing map generator. Existing 2× assets are unchanged.
Both source and generated map attribution stay under LICENSE-ASSETS / CC BY-SA.

`IDLE_WORLD_MAP_SCALE=3` selects XL only for newly created managed runtimes.
The default remains the existing map. Recovery uses the map/config already
persisted with each runtime, not the current operator setting.

## Measured CPU and delivery costs

One actual server worker, 2,000 bots, 107 default nations, two human identities,
6,000 ticks, ordinary expansion intents, two real GameViews after a late join.
The larger-map fixture was generated in an isolated ignored performance folder.
The second view joined at tick 3,001 and matched the first view's tile state,
unit positions and player reserves at the end.

| Measurement                                          |                      Result |
| ---------------------------------------------------- | --------------------------: |
| Server simulation + view encoding, mean              |                    78.86 ms |
| Server p95 / p99 / maximum                           | 123.35 / 187.91 / 341.69 ms |
| Ticks over the 100 ms target                         |                 841 / 6,000 |
| Estimated serial CPU capacity                        |               12.68 ticks/s |
| Hypothetical fixed-clock debt, maximum / final       |         2,061.85 / 17.48 ms |
| Client decode + GameView apply, mean / p95           |              4.19 / 6.46 ms |
| Process RSS peak, server worker + two headless views |                     2.64 GB |
| Uncompressed live frame, mean                        |               390,936 bytes |
| Sampled deflated live frame, mean                    |                67,402 bytes |
| Initial snapshot, raw / estimated deflated           |           169.33 / 36.81 MB |
| Initial snapshot chunks                              |                       1,275 |
| Local snapshot generation/application                |                      2.18 s |

This was ten minutes of simulated age, not a twelve-hour soak. Timing excludes
DOM/GPU execution, Internet latency and real socket compression; the serial CPU
capacity is **not measured live TPS**. Other development activity existed on the
host. Memory is whole benchmark-process RSS, not the phone footprint. Population
was deliberately held constant to isolate area; equal density would exceed the
current owner-ID capacity. No 10×-area claim is made.

## Join and camera fixes

The 1,275-chunk snapshot exceeded the old 1,024-entry live queue. Initial map
snapshots now drain separately through the same eight-frame ACK window, releasing
consumed packet references. Live queues still have byte/count bounds and the
30-second no-progress timeout. This does not yet stream snapshot generation:
the current immutable map image is still materialized in server memory.

Catchup enters a whole-map camera view once, before applying the first pending
update. Automatic nation focus waits for initial snapshot completion. Touch
and mouse zoom can start smoothly from the whole-map scale, including on phones.
The top-to-bottom painting order and map rendering are unchanged. No artificial
animation delay is added to loading or to the simulation.

## Start and constraints

Validation: full suite **305 files / 3,210 tests passed**, then two additional
short/long quick-start cases passed separately. TypeScript, changed-file linters
and the production Vite build passed. Real worker tests need an unsandboxed
Node account lookup on this Windows host. No on-phone visual validation or
12-hour soak has been claimed.

Activated September 5 after the user explicitly approved the backend restart.
The development backend runs commit `277df804` with `IDLE_WORLD_MAP_SCALE=3`
and one gameplay worker. The authenticated public tunnel serves the new build
and the 12,324 × 5,844 manifest with all 78 pages.

The live three-client socket smoke test on an XL one-day world passed:
**9.94 live TPS**, 359 matching frames across the healthy clients, successful
reconnect, player-action query and observed attack input. The third client
stopped acknowledging and did not block the others. Start-message assertions
verified the XL map and disabled forced time limit. This is about 36 seconds
of live updates, not a twelve-hour stability test. The first harness attempt
used the wrong start-message config property; correcting the test to `config`
resolved that harness error without a gameplay change.

Both disposable smoke-test worlds were cancelled/archived with their history
retained. A final backend restart, after no active managed player connections
remained, removed those temporary simulations. No user long playtest was
started automatically. No further restarts should happen during play.

Expo Go SDK 57 initially rejected the anonymous CLI preview. Browser login on
the host completed, and Metro was restarted under the authenticated Expo
account. The live preview is
`exp://mdv4nt4-mushroomlemonade-8081.exp.direct`; the phone must also sign into
Expo Go. HTTP manifest checks alone do not certify successful on-phone launch.

To start the playtest on the now-active development backend:

1. Open `https://atlas-dev.sightings.today/worlds?debug=1` and fully reload.
2. Enable **Long session**, then **Quick start**. This creates the world at the
   player's click rather than letting a test run before they arrive.
3. Other devices can use **Quick join** during the one-minute countdown.
4. Confirm the map is Expanded Earth XL and execution is Server simulation.
5. Save the world/lobby link for returning; report TPS, stalls, mobile reloads,
   join time and the point in the game when problems appear.

Normal victories still apply. The larger renderer retains full-map CPU/GPU
state and needs real phone validation. A roughly 37 MB compressed late join can
take noticeable time on mobile networks. Full engine checkpoints and crash-safe
long recovery are still unfinished: a machine crash or manual server restart
can require a long journal replay. Keeping the development server alive avoids
the planned four-hour production restart, not those failure modes.

Reproduce:

```text
node scripts/generate-expanded-earth.mjs --scale=3 --output-root=tests/perf/output/<fresh-directory>
tsx tests/perf/client/AuthoritativePerf.ts 6000 tests/perf/output/<fresh-directory> 2000
node scripts/generate-expanded-earth.mjs --variant=large
tsx tests/perf/client/AuthoritativeSocketSmoke.ts --long --large
```

The socket harness creates a real development world. Archive that disposable
world and clear its simulation after testing; do not leave a one-day benchmark
world competing for CPU with the user's playtest.
