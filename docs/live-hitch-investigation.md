# Live hitch investigation — September 27

Read-only diagnosis of preview game P3KetcPc while play continued. No restart,
gameplay patch, intent, or configuration change. A bounded tick-completion probe
was installed then removed (571 recorded ticks); the loopback inspector was
closed. A 25.30-second V8 profile was correlated with completion timestamps.

Private raw captures in `.dev-logs/profiles/`:
- `P3KetcPc-1790544783016.cpuprofile`
- `P3KetcPc-cadence-1790544793505.json`

## Findings

252 fully captured tick windows: 208 <=100 ms, 44 >100 ms. Approximate sampled
milliseconds per tick, grouped by completed tick duration:

| Work | <=100 ms ticks | >100 ms ticks |
| --- | ---: | ---: |
| Routing | 1.6 | 44.4 |
| Continuous pressure | 14.6 | 15.0 |
| Nation transport scans | 13.0 | 13.1 |
| Border cluster cleanup | 7.5 | 7.8 |
| Attack expansion | 6.9 | 7.0 |
| View encoding | 6.6 | 6.7 |
| Map name placement | 3.1 | 3.0 |
| Other | 26.2 | 28.2 |

Routing accounted for about 108–131 ms in several 184–212 ms ticks. Across the
profile, routing call stacks attributed roughly 1,927 ms to trade ships versus
356 ms to warship patrols. These are sampled attribution estimates, not an
instrumented count of searches or an A/B comparison with the old release.

Source inspection confirms `TradeShipExecution.init` skips
`queueWaterPreparation` whenever `tradeCorridors` is present. Live navigation
metrics showed four workers but zero jobs/batches. Cache misses and connector
searches can therefore run expensive repairs synchronously on the simulation
thread. Shared routes reduce repeated work, not the latency of every miss.

Nation transport tracking calls `game.units(TransportShip)` independently per
nation; the implementation enumerates every player and rebuilds the result.
Continuous-pressure contact caches rescan a player's entire border when dirty;
territory changes repeatedly dirty neighboring players. Both explain substantial
baseline overhead even on ticks without routing spikes.

## Recommended implementation order

1. Restore deterministic background preparation for corridor misses and
   connectors, consuming results in authoritative order; no wall-clock-dependent
   gameplay decisions. Avoid speculative whole-route work on cache hits.
2. Replace repeated global transport enumeration with a shared index maintained
   through spawn/removal/capture, preserving existing targeting and ordering.
3. Maintain frontier contact counts incrementally from territory changes,
   retaining exact border/terrain semantics and regression coverage.
4. Reprofile baseline and p95/p99 after these changes before deciding whether
   border-cluster work needs further redesign.

## Limitations

Sampling and diagnostic attachment add overhead. Partial first/last profile
ticks are excluded. Sampling gaps >10 ms are left unattributed: notably a
296.6 ms gap means the largest observed stall cannot be assigned confidently to
the function sampled afterward. No claim that every visible hitch is server-side;
client rendering and network delivery were not profiled. No live fixes deployed.

## Implementation checkpoint

The three changes are implemented in the canonical development checkout only;
the live preview and its active match have not been replaced or restarted.

### Routing

- Trade-ship creation now queues corridor-aware preparation hints again.
- Preparation checks the shared route first. Warm journeys cause no route jobs.
- Cold journeys prepare native routes; potential corridor joins prepare only
  their missing connectors, followed by a direct fallback only if needed.
- Two bounded preparation phases, at most 128 hints, deduplicated endpoints.
- Results are consumed in request order, checked against terrain/graph revision,
  and stored in the normal exact cache. Preparation never increments corridor
  popularity, publishes a route, spends resources or consumes gameplay RNG.
- Even a single job uses the available worker pool; previously batches smaller
  than two fell back to main-thread repair. Pool failure retains native fallback.

Important limitation: the authoritative tick still awaits its preparation batch.
Parallel work reduces simultaneous search cost, not the latency of an arbitrary
single long search. Coarse planning remains synchronous. Unexpected mid-tick
reroutes (capture, changed destination/terrain, or newly selected corridors) can
still require synchronous fallback. This is not a completed asynchronous,
multi-tick routing redesign or a guarantee that every hitch is eliminated.

### Transport enumeration

Game-wide single-type queries now visit only owners with units of that type.
The index is maintained by existing ownership add/remove hooks, including
capture and deletion. It references existing unit buckets instead of copying
all units, and preserves original player/unit ordering. Returned arrays remain
caller-owned. This addresses the repeated global scan without changing nation
decision frequency, information access or retaliation rules.

### Pressure contacts

Cardinal contact counts change incrementally around captured/relinquished tiles.
Width calculations use counts directly. Ordered attack iteration is reconstructed
in the original border/cardinal order only when needed, stopping after all
contact neighbors are found. Rare terrain edits re-seed affected owners because
terrain notifications do not include the previous byte. No per-border-tile
contribution cache or extra terrain map is retained.

### Bounded microbenchmarks

`scripts/benchmark-hitch-indexes.ts`, one warmed run on this machine:

| Fixture | Previous scan | Indexed |
| --- | ---: | ---: |
| 1,000 typed queries, 3,000 owners, one matching unit | 64.33 ms | 0.21 ms |
| 200 local changes/width queries, 512 scattered owned tiles | 10.34 ms | 0.31 ms |

Results/count checksums match. The pressure candidate observer is active in both
timings; this isolates query savings, not the net cost of installing that observer.
Fixtures are synthetic and favorable, not mature-world benchmarks or promised
whole-game improvements. Full replay benchmarking was deliberately not run
alongside the user's active longplay.

Verification: 190 tests passed across 16 suites, including native warship/trade
behavior, pressure rules, player/unit lifecycle, corridor preparation, real
single-job worker routing, failure fallback, terrain invalidation and exact
contact-order comparisons. TypeScript, changed-file ESLint, production build
and whitespace checks passed. Existing stone-texture/chunk-size build warnings
remain. Preview health was checked successfully; no deployment was performed.
