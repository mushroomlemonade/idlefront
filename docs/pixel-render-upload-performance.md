# Pixel renderer upload batching — 2026-09-08

User reported 5–10 FPS in Chrome on a MacBook. No direct Mac performance trace is available. Stationary versus moving-camera behavior was asked, not yet answered. Do not claim the Mac FPS is fixed without retest.

Found a measurable pathological submission path in `OverviewMapPass`: each visible changed tile allocated two one-element arrays and sent two texture-array uploads; each changed overview cell then sent two further uploads. A dense 20,000-cell fixture produced 40,000 overview + 40,000 detail calls.

Changed to persistent, bounded CPU mirrors per resident detail page and dirty row-span uploads. A page gets at most two uploads per draw; the overview gets at most two contiguous row-span uploads. Unchanged representative pixels are skipped, repeated updates coalesce to final state, dirty evicted pages cannot upload into reused slots, and a full overview upload clears its pending changes.

Same synthetic fixture now produces 2 overview + 2 detail uploads. Mock-driver JavaScript time was about 90 ms before and 7–8 ms after; **these are not real GPU timings or Mac FPS**. CPU mirrors cost at most 18 MiB for 96 resident 256² pages. This trades bounded transfer bandwidth and CPU memory for eliminating per-pixel driver calls. Sparse updates spanning distant rows can still upload a wide unchanged region; finer dirty-block batching is a potential follow-up if transfer bandwidth measures poorly.

Validation: eight focused renderer tests, TypeScript no-emit, and real headless Chrome/WebGL batch-update fixture passed. The headless test uses virtual time, so its displayed 0 ms is not a meaningful timing measurement. Shader/GL correctness only. Backend health remained OK; no backend restart in this pass.

Still to profile if slow: synchronous page population during pan/LOD switches, Retina fragment workload, other unit/HUD layers, and real-game update volume. No frame-rate cap, gameplay changes, or slower server tick rate were introduced.
