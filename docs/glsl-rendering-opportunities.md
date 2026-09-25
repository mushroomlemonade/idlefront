# GLSL Rendering Opportunities

Status: point of interest for a future development cycle  
Scope: presentation and rendering only; no simulation, balance, hit-testing, or map-rule changes

## Long-term gameplay context

IdleFront is expected to add new structures in a distant development phase to
extend the late game beyond the present OpenFront arc. This is a long-term
roadmap direction, not authorization to alter the current structure set or its
balance during rendering, application-architecture, or pacing work.

Those structures should be designed only after persistent-world pacing and the
application loop have been validated. Their mechanics must remain authoritative
game-state behavior rather than shader behavior. The renderer may eventually
give them distinct construction, operation, damage, and completion effects, but
visual work must follow the approved mechanics and preserve the current ruleset
as the baseline “laws of physics.”

## Why this is worth revisiting

The map is already a substantial WebGL2 application rather than a canvas with a
few cosmetic filters. The current source contains 76 GLSL files and a normalized
multi-pass renderer. It already performs GPU border computation, integer-texture
territory updates, instanced unit and structure drawing, MSDF text, day/night
compositing, point lighting, fallout bloom, trails, shockwaves, attack rings,
nuclear telegraphs, and framebuffer-based heat decay.

That makes shader work a credible future product surface. The best opportunities
extend existing passes and preserve the deliberately pixelated, highly readable
OpenFront board. They should not turn the map into a soft, cinematic backdrop or
move game logic onto the GPU.

Relevant source entry points:

- `src/client/render/gl/Renderer.ts` defines the render order and pass wiring.
- `src/client/render/gl/shaders/` contains the GLSL ES 3.00 shader library.
- `src/client/render/gl/passes/` owns the draw passes and framebuffer targets.
- `src/client/render/gl/utils/HeatManager.ts` demonstrates persistent GPU state
  with ping-pong textures and transition detection.
- `src/client/render/gl/shaders/world-text/world-text.frag.glsl` already uses
  multi-channel signed-distance-field text for resolution-independent labels.
- `src/client/render/gl/initGL.ts` requires hardware-accelerated WebGL2 and
  explicitly handles limited texture sizes and software renderers.

## Opportunity shortlist

| Opportunity | Existing foundation | Product value | Cost/risk |
| --- | --- | --- | --- |
| Recent-history overlay | Tile textures, scatter updates, `HeatManager`, trails | A fading record of recently contested borders, attacks, or activity would make an asynchronous world feel alive when a player returns. It could also support a concise catch-up playback. | Medium. History must be generated from authoritative events, bounded in memory, and visually distinct from current ownership. |
| Subtle terrain material | Terrain and map-layer passes, camera/zoom uniforms | Very restrained relief, shoreline response, or regional grain could add physicality while retaining the original pixels and palette. | Low to medium. Easy to over-soften the board or reduce contrast on mobile. |
| Event light language | Point lights, lightmap, fallout light, bloom, shockwave and sprite passes | Structure completion glints, diplomacy pulses, attack-pressure ripples, and world-start accents could communicate important state without adding UI panels. | Low for isolated effects; medium if many can overlap. Must be rate-limited. |
| Relationship and focus modes | Integer relationship textures, border compute, affiliation palette | Stronger selected-player isolation, alliance outlines, threat emphasis, and color-vision-safe palettes can improve comprehension without changing rules. | Low. This is the safest useful shader work. |
| Persistent-world atmosphere | Day/night composite and lightmap | City lights, restrained road/rail illumination, or a world-age palette can express a world's phase and make repeat visits feel different. | Medium. Atmosphere must never obscure unit, border, or structure information. |
| Better strategic text | Existing MSDF atlas, instanced world text and name programs | More consistent Retina-scale labels, status marks, small annotations, and zoom-aware decluttering can improve mobile readability at modest draw-call cost. | Low to medium. Atlas and instance-buffer budgets need measurement. |
| Cosmetic material skins | Texture arrays already used for structures/flags, palette-driven territory | Optional board materials or event themes could vary presentation without forking simulation data. | Medium. Requires a strict asset budget and must not make player colors ambiguous. |

## Concrete prototypes to consider

### 1. World memory

Add a low-resolution, decaying activity texture modeled on the fallout heat
pipeline. Authoritative events would stamp intensity and category into it;
ping-pong decay would happen on the GPU. Possible renderings include a faint
front-line afterimage, an activity glow visible after returning, or a short
time-compressed catch-up layer.

This is the most strategically relevant shader experiment for IdleFront because
it helps communicate persistence. It should visualize events already accepted by
the server, never infer or decide gameplay outcomes.

### 2. Material-preserving terrain treatment

Prototype one restrained full-screen or terrain-pass treatment:

- a one-pixel shoreline/wet-edge response;
- zoom-dependent relief from existing map information;
- very low-amplitude grain locked to world coordinates; or
- a palette lookup table for accessibility and atmosphere.

The acceptance test is that borders, ownership colors, structures, and unit
silhouettes remain at least as legible as the current renderer. The treatment
should fade out at tactical zoom if it competes with information.

### 3. Semantic event accents

Reuse the current instanced effect and light passes for a small visual grammar:

- expansion/attack: outward pressure ring;
- construction: contained upward glint;
- diplomacy: slow shared-color pulse along the relationship boundary;
- urgent threat: short, localized alert response; and
- return/catch-up: chronological event pulses rather than a large blocking UI.

Effects should be data-driven, pooled, capped per frame, and suppressible by a
reduced-motion setting.

### 4. Focus and accessibility modes

The border-compute and affiliation pipeline makes a low-risk experiment possible:
a focus mode that quiets unrelated territory, strengthens the selected player's
relationships, and offers color-vision-safe palette transforms. This should be a
display preference only and should avoid changing the canonical territory
texture or relationship calculation.

## WebGL2 capabilities that are relevant

The Khronos WebGL2 specification exposes the underlying pieces already used here:
framebuffer objects, instanced drawing, integer and array textures, multiple draw
buffers, uniform buffers, transform feedback, and 3D/2D-array texture targets.
The renderer already uses framebuffers, instancing, integer textures, floating
color buffers, and texture arrays, so additional experiments can fit its present
architecture instead of introducing a second rendering system.

Two optional extensions are particularly useful before adding more effects:

- `EXT_disjoint_timer_query_webgl2` can measure elapsed GPU time asynchronously.
  It should be used to establish per-pass budgets on representative iPhones,
  Android devices, and desktop GPUs rather than guessing from CPU frame time.
- `KHR_parallel_shader_compile` lets the client poll shader/program completion
  without forcing a blocking status check. With many programs, this could reduce
  startup hitches or support compiling optional effects after the first playable
  frame. It is an optional optimization and needs a fallback path.

Transform feedback, multiple render targets, or heavier texture-array schemes are
possible under WebGL2, but they are not automatically improvements. They should
only be adopted after a prototype demonstrates a measurable reduction in draw
cost, uploads, or memory traffic.

## Performance and compatibility guardrails

Before visual expansion, add a small renderer benchmark mode and capture:

- GPU time per expensive pass when timer queries are supported;
- CPU render time and frame pacing when they are not;
- framebuffer/texture memory estimates at common map sizes and DPRs;
- first-playable-frame and shader-link latency;
- overdraw during worst-case effects; and
- behavior on context loss, thermal throttling, and limited texture-size devices.

Suggested budgets should be tiered. Expensive ambient work can render at reduced
resolution and update less frequently, while borders, territory, units, and input
feedback remain full-rate. Every optional pass needs a clean disabled path. Avoid
readbacks during play, unbounded effect counts, per-frame shader compilation,
large-kernel blur stacks, and full-resolution ping-pong buffers unless profiling
justifies them.

## Deliberate non-goals

- No shader-driven gameplay, AI, ownership, collision, or authoritative timing.
- No full physical-based-rendering conversion of the board.
- No heavy parallax, refraction, volumetric fog, or screen distortion over tactical information.
- No visual effect that makes a territory, relationship, unit, or selectable area misleading.
- No dependency on an optional extension for correct rendering.
- No erosion of the intentional contrast between the crisp, pixelated game board
  and the high-fidelity application chrome.

## Recommended first future cycle

1. Add instrumentation and record a baseline on at least one recent iPhone, one
   older iPhone, a mid-range Android device, and desktop Chrome/Firefox/Safari.
2. Prototype the recent-history texture behind a developer flag.
3. Prototype one accessibility/focus treatment and one restrained terrain
   material treatment.
4. Compare readability and GPU cost against the unchanged renderer in identical
   game states.
5. Keep only the effects that communicate state better, not merely those that
   look more elaborate.

## Primary references

- [Khronos WebGL 2.0 specification](https://registry.khronos.org/webgl/specs/latest/2.0/)
- [Khronos OpenGL ES Shading Language 3.00 specification](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf)
- [Khronos `EXT_disjoint_timer_query_webgl2` specification](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/)
- [Khronos `KHR_parallel_shader_compile` specification](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/)
- [Khronos WebGL extension registry](https://registry.khronos.org/webgl/extensions/)
