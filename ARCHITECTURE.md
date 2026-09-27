# Hanakawa (formerly Luma Coast): architecture contract

A browser boating game along a Japanese river valley (see docs/BRIEF.md v2). TypeScript + Vite 8 + three.js r186 `WebGPURenderer` (TSL/node materials only) + Rapier 0.20 (`@dimforge/rapier3d-compat`). WebGPU first, WebGL2 fallback via `?backend=webgl`.

This file is the frozen cross-module contract. Modules are built in parallel by different owners; code only against what is written here. If you need something new from another module, publish it through `ctx.services` or report it. Do not edit other owners' files.

## Commands

- `npm run dev`: Vite on http://127.0.0.1:5190 (already running in the background during development; check with `curl -s 127.0.0.1:5190 >/dev/null && echo up`)
- `npx tsc --noEmit 2>&1 | grep src/<yourdir>`: typecheck only your area (other areas may be mid-edit)
- `npm test`: node unit tests in `test/unit/*.test.mjs` (node runs `.ts` imports directly via type stripping, so avoid TS-only syntax like enums/namespaces/parameter properties in files you want unit-testable)
- `npx tsx tools/bake/index.ts`: world bake into `public/world/`
- `node tools/polyhaven.mjs search <term> --type=textures|models|hdris` and `node tools/polyhaven.mjs <id> --out=public/assets/<yourmodule> --res=1k|2k [--maps=Diffuse,nor_gl,arm,Rough,Displacement]`: download a CC0 asset with provenance
- `node tools/assets-report.mjs`: regenerate `ASSETS.md` from every `provenance.json`
- `node test/harness.mjs <script> [--backend=webgl] [--quality=high] [--views=harbor,cove] [--tag=<yourmodule>] [--size=1920x1080]`: headless Chrome run of `test/scripts/<script>.mjs`

## Browser testing rules

- Only one Chrome may run at a time on this machine. The harness takes a global lock (`/tmp/luma-browser.lock`) and queues. Never launch Chrome, Playwright, or any browser any other way. Keep each harness run short (a few views, no long loops) because others are waiting.
- Screenshots go to `shots/<tag>/`. Always pass `--tag=<yourmodule>` so you do not overwrite other people's shots.
- The harness pumps `requestAnimationFrame` with a timer (headless parks rAF) and stubs pointer lock.
- `window.__luma` debug API: `view(name)` / `look([x,y,z],[tx,ty,tz])` / `clearView()` camera override; `hold(action, on)`, `press(action)`, `releaseAll()` input simulation; `setQuality(name)`; `stats()` (fps, frameMs, draw calls, triangles, failed modules, boat pose); `ctx` is the full GameContext. Named views live in `src/core/debug.ts` (`opening` = the reference composition, `village`, `red-bridge`, `pagoda`, `stone-bridge`, `gorge`, `lake`, `teahouse`, `falls`, `aerial`; older island names alias to these).
- Write your own scripts as `test/scripts/<yourmodule>-*.mjs`. A script is `export default async function (g) { ... }` with `g.viewShot(view, name)`, `g.shot(name)`, `g.luma(expr)` (expr sees `L = window.__luma`), `g.evalJs`, `g.stats()`, `g.delay(ms)`, `g.errors`, `g.args`.

## Directory ownership

| Path | Owner |
|---|---|
| `src/main.ts`, `src/core/**`, `src/world/waves.ts`, `src/world/worldData.ts`, `src/world/layout.ts`, `test/harness.mjs`, `tools/polyhaven.mjs`, `ARCHITECTURE.md`, `docs/**` | integrator (lead). The terrain owner may tune `RIVER_POINTS` values in layout.ts; everything else there goes through the lead |
| `src/render/**` | render: sky, sun, environment/IBL, shadows (CSM), fog, river mist, aerial perspective, probes, post, tone mapping |
| `src/water/**` (incl. `src/water/caustics.ts`) | water: river surface, reflection/refraction, depth color, flow ripples, bank lapping, caustics, wake, spray, waterfalls' falling water |
| `tools/bake/**`, `public/world/**`, `src/terrain/**` | terrain: valley bake, river channel and bed, banks, hills, gorge, lake, terrain rendering, rocks/boulders, distant mountains, terrain collider |
| `src/vegetation/**` | vegetation: forests (conifers, deciduous, bamboo, cherry, maple), grass, reeds, flowers, lotus/lilies, falling and floating petals, wind |
| `src/structures/**`, `src/world/sites.ts` | structures: village houses, pagoda, shrine, torii, teahouse, mill, village props, moored boats; `sites.ts` lists building footprints the bake flattens |
| `src/bridges/**` | bridges + river infrastructure: the four bridges, landing docks, stone embankments/steps, lantern posts, the weir |
| `src/boat/hullSpec.ts`, `src/boat/model/**` | boat model: Japanese river boat, canopy, finishes |
| `src/boat/index.ts`, `src/boat/physics/**`, `src/camera/**` | boat physics + cameras |
| `src/game/**`, `src/ui/**` (incl. `src/ui/base.css`, `index.html` markup inside `#ui`/`#loading`) | gameplay + UI |
| `src/audio/**` | audio |
| `public/assets/<module>/**` | that module (download your own assets here) |
| `test/scripts/<module>-*.mjs`, `shots/<module>/` | that module |

## Module contract

Each `src/<module>/index.ts` exports `async function init(ctx: GameContext)`. `main.ts` dynamically imports modules in this order: render, terrain, water, vegetation, structures, bridges, boat, camera, game, ui, audio. A module that throws during import/init is logged and skipped; per-frame callbacks are wrapped so one module's exception does not stop the loop. Still: never ship a throwing module.

`GameContext` (`src/core/context.ts`) gives: `renderer`, `backend` ('webgpu'|'webgl2'), `scene`, `camera` (single PerspectiveCamera, fov 60), `canvas`, `time` (`real`, `sim`, `render`, `alpha`, `frameDt`, `fixedDt`=1/60), `sun` (`direction` toward the sun, `color`, `intensity`; the render module writes it during init), `world` (WorldData), `physics` (PhysicsWorld), `events`, `input`, `assets`, `settings`, `quality` (current QualityPreset), `paused`, `boat` (BoatApi|null), `cameraRig` (CameraApi|null), `onUpdate(fn, order)`, `onFixed(fn, order)`, `onPostFixed(fn, order)`, `render()` (the render module replaces it), `services` (free registry).

Update order convention (`onUpdate`): shared uniforms -100, boat interpolation 10, camera 50, water/wake 60, vegetation 65, audio 80, ui 90. Rendering happens after all updates.

Loop: fixed 1/60 s physics with accumulator, at most 5 steps per frame, stalled frames clamped to 100 ms, clock reset when the tab returns. Rendered state is interpolated with `time.alpha`; `time.render` is the sim time that matches the interpolated pose, and the GPU ocean must use it (via `uWavePhases`).

## Coordinates and units

- Meters, seconds, kilograms. `y` up, river surface `y = 0` (a calm lowland river at constant level; the weir and falls close the ends). North = `-z`, east = `+x`.
- Headings are compass degrees (0 = north, 90 = east) describing where the bow points. Use `headingToForward` / `forwardToHeading` from `src/world/layout.ts`; never hand-roll yaw math.
- Boat local frame (`src/boat/hullSpec.ts`): origin at midships on the centerline at the design waterline; bow toward `-z`, starboard `+x`, up `+y`. World forward = `(0,0,-1).applyQuaternion(q)`.
- World extent: `WORLD_SIZE` = 2048 m square centered on the origin. The river banks bound the player (no radius boundary).

## World data (`src/world/worldData.ts`, produced by `tools/bake`)

`public/world/world.json` lists channels; each is a square grid over [-size/2, size/2], row 0 at z = -size/2, column 0 at x = -size/2, texel centers at `(i + 0.5) * size / res`. Required channels, which other modules rely on:

- `height`: terrain/seabed height in meters (u16)
- `shore`: signed distance to the coastline in meters, + inland, - offshore, clamped to ±64 (u8)
- `waveScale`: 0..1 local wave amplitude multiplier (calmer under banks and in shallows); the cpu wave sampler uses it through `setWaveScaleFn`, the gpu must sample the same channel at the rest position
- `flowX`, `flowZ`: river surface current in m/s (downstream, roughly 0.2-0.6 m/s in the channel, near 0 in the lake and at the banks); physics adds it to the water velocity, the water shader advects ripples and petals along it
- `sand`, `grass`, `rock`: 0..1 surface masks

The terrain owner may add channels (e.g. `flowers`, `shrubs`, `trees`, `cliff`, `wet`, `ao`, `path`). CPU: `world.sample(name, x, z)`, `heightAt`, `depthAt`, `normalAt`. GPU: `world.texture(name)` or `world.channelNode(name, positionWorld.xz)` (decoded float).

## Waves (`src/world/waves.ts`)

The single source of truth for the ocean surface. Components (direction, wavelength, amplitude, steepness, phi0) are constants; phases `(omega*t) mod 2pi` are computed on the CPU and uploaded as `uWavePhases` (`src/core/uniforms.ts`) each frame, so the GPU never evaluates sin of large times. The GPU displacement must reproduce `displacement()` exactly, including horizontal (Gerstner) displacement and `waveScale` sampled at the rest position. CPU queries: `waterHeight(x, z, t)`, `sampleWater(x, z, t, out)` (height, normal, particle velocity) invert the horizontal displacement. Physics uses `ctx.time.sim`; rendering uses `ctx.time.render`. Fine ripples exist only as GPU normal detail.

## Shared uniforms (`src/core/uniforms.ts`)

`uTime` (render sim time), `uRealTime`, `uWavePhases` (float array), `uWaveAmp`, `uSunDir`, `uWindDir` (vec2), `uWindStrength`. Grass, trees, flags, and water ripples must all use the same wind.

## Rendering rules

- Node materials and TSL only (`three/webgpu`, `three/tsl`). No `onBeforeCompile`, no GLSL/WGSL strings, no legacy `WebGLRenderer` passes.
- Linear workflow. Albedo/color textures `SRGBColorSpace`; normal/roughness/arm/height `NoColorSpace` (`ctx.assets.texture(url, { srgb })` handles this). Exactly one tone mapping + output conversion, owned by the render module. Materials never tone map or gamma-correct themselves.
- Physically based values: albedo in plausible ranges (fresh grass ~0.15-0.3 linear, limestone ~0.5-0.65, white paint ~0.8, never 1.0), roughness from textures where available.
- Layers (`src/core/layers.ts`): the planar reflection camera renders only layer 0. Put grass, flowers, tiny props, and particles only on `LAYERS.NO_REFLECT` so they skip the reflection pass. The main camera sees both.
- Shadows: large static meshes `receiveShadow`; casters limited to things that matter (boat, buildings, trees, cliffs, rocks near the camera). Grass does not cast.
- Every module scales with `ctx.quality` and listens to `ctx.events.on('quality', ...)`. Balanced preset target: 60 fps at 1920x1080. Budgets: water incl. reflection <= 4 ms, terrain <= 2 ms, vegetation <= 3 ms, structures <= 1.5 ms, shadows <= 2.5 ms, post <= 3 ms.
- WebGL2 fallback must work for every module (reduced quality is fine). Test with `--backend=webgl`.

## Physics

`ctx.physics.world` is a Rapier world with gravity -9.81 and timestep 1/60. Static geometry uses `ctx.physics.addStatic(desc, GROUPS.X)` / `addBox(...)`. Collision groups in `src/core/physics.ts`: TERRAIN, STATIC, BOAT, PROPS, SENSOR. The terrain heightfield collider is created by the terrain module. Continuous custom forces (buoyancy, drag, thrust) are reset and recomputed each step (`resetForces/resetTorques` then `addForceAtPoint`).

## Services (`ctx.services`)

- `water`: `{ mesh, reflectionEnabled(boolean), setBoatMask(...)?, ... }` published by water; caustics are a pure import: `causticsNode(worldPos, worldNormal?)` from `src/water/caustics.ts`, safe to call from any material at build time.
- `terrain`: published by terrain (e.g. `rockMaterial`, `heightAt` convenience).
- `boatModel`: `createBoatModel` from `src/boat/model/index.ts`: `(ctx, { paint?, detail?: 'full' | 'simple' }) => Promise<{ root: Group; setPaint(id: string): void; paints: { id, name, unlock?: string }[]; wheel?: Object3D; propeller?: Object3D; dispose(): void }>`
- `game`: published by gameplay for the ui (objectives, active target position, prompt text).
- `audio`: published by audio (`play(name, opts)` for one-shots).

## Events (`ctx.events`)

| name | payload | emitted by |
|---|---|---|
| `input:<action>` | - | core input (forward, reverse, left, right, camera, interact, chart, pause, reset) |
| `loading:progress` | `{ progress, label, pending }` | core assets |
| `game:ready` | - | core |
| `resize` | `{ width, height }` | core |
| `settings:change` | `Partial<Settings>` (emit this to change settings; core persists) | ui |
| `quality` | `QualityPreset` | core, after a quality change |
| `pause` / `resume` | - | ui (sets `ctx.paused`) |
| `camera:mode` | `CameraMode` | camera |
| `boat:impact` | `{ strength, x, y, z }` (strength ~ m/s closing speed) | boat physics |
| `boat:splash` | `{ strength, x, y, z }` | boat physics / water |
| `boat:docked` / `boat:undocked` | `{ dockId }` | game |
| `objective:started` / `objective:completed` | `{ id, title }` | game |
| `discovery` | `{ id, name }` | game |
| `unlock` | `{ id, name }` | game |
| `ui:chart` | `boolean` open | ui |

## Layout (`src/world/layout.ts`)

One river centerline spline (`RIVER_POINTS`, Catmull-Rom, downstream to upstream) with widths. Everything is placed by along-river distance `s` (0 at the weir, `RIVER_LENGTH` ~2119 m at the falls) and `side` (-1 left bank, +1 right bank, facing upstream). Helpers: `riverFrame(s)` (center, upstream tangent, right normal, width), `nearestRiver(x, z)` (s, signed lateral), `bankPoint(s, side, offset)`, `riverHeading(s)`. Data: `DOCKS` (village, temple, teahouse, mill; each with derived `moorX/moorZ/headingDeg`, bow upstream), `BRIDGES` (red-arch, stone-arch, covered, plank; `clearance` above water), `LANDMARKS` (weir, village, shrine, pagoda, torii, gorge, cascade, teahouse, mill, falls), `POIS` (derived, for discoveries), `HARBOR` (village quay, legacy name), `SPAWN`, `SUN` (azimuth 118, elevation 36). Never hard-code world positions: derive them from these so the river can be reshaped.

`src/world/sites.ts` (structures owner) lists building footprints (center, half size, yaw, ground height) that the bake flattens; bridges' abutments and landings are derived by the bake from `BRIDGES`/`DOCKS`.

## Controls

W/S thrust forward/reverse, A/D steer, mouse move (pointer lock) or drag to look, C camera mode (follow → helm → photo), E dock/interact, M chart, Esc pause, R reset/unstuck. Photo camera: WASD fly, Space/Q up/down, Shift fast.
