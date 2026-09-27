# Hanakawa

**[View Repository on GitHub](https://github.com/vishal-tiwari9/Agenthon-hanakawa-boat-game-)**

A playable Japanese river boating game built with TypeScript, Vite, Three.js WebGPURenderer/TSL and Rapier. Cruise a forested valley in a wooden canopy boat, pass beneath four bridges, visit riverside landings and complete optional deliveries and discoveries.

## Run

```sh
git clone https://github.com/vishal-tiwari9/Agenthon-hanakawa-boat-game-.git
cd Agenthon-hanakawa-boat-game-
npm ci
npm run dev
```

Open http://127.0.0.1:5190 in Chrome. WebGPU is preferred. Use `?backend=webgl` to force the reduced WebGL2 backend, or `?quality=low`, `?quality=balanced`, `?quality=high` to select a preset. Balanced is recommended.

```sh
npm run build
npm run preview
```

The production build is in `dist/`. Preview serves it on port 5191. All runtime assets are local; attribution is in `ASSETS.md` and per-asset provenance files.

## Deploy on Vercel

The site is fully static. Import the [GitHub repo](https://github.com/vishal-tiwari9/Agenthon-hanakawa-boat-game-) in Vercel (Add New, Project) and deploy; `vercel.json` already sets the Vite framework, `npm ci`, `npm run build` and the `dist` output, and `package.json` asks for Node 22.12 or newer. No environment variables are needed. Deploy from Git rather than `vercel deploy` from this folder: the Hobby CLI upload is capped at 100 MB and the assets are about 240 MB.

## Controls

| Input | Action |
|---|---|
| W / S | Ahead / reverse thrust |
| A / D | Steer |
| Mouse / drag | Look around |
| C | Follow, helm, photo camera |
| E | Cast off or dock nearby at low speed |
| M | River chart and objectives |
| Escape | Pause, settings, boat finishes, New Game |
| R | Recover a grounded boat to a safe river position |
| Space / Q, Shift | Photo camera up / down, faster travel |

Click **Set out**, then press **E** to cast off. Progress, cargo, the last berth and unlocked finishes save locally. Audio starts after an interaction; volume controls are in the pause menu.

## Verification

```sh
npm test
node test/harness.mjs game-play --tag=verify --size=1280x720
node test/harness.mjs game-play --backend=webgl --tag=verify --size=1280x720
node test/harness.mjs finish-save --tag=verify --size=1280x720
node test/harness.mjs finish-controls --tag=verify --size=1280x720
```

The browser harness requires local Chrome on macOS, serializes its runs with a lock, and always uses `--mute-audio`. Gameplay checks drive the boat briefly and teleport between distant objective locations; they are not a continuous end-to-end voyage. Pointer lock is stubbed in headless Chrome, so physical mouse/pointer-lock behavior needs manual checking.

Verified during the final integration pass:
- production build and physics/wave tests;
- finite stone-bridge geometry regression;
- all eight objectives on WebGPU and WebGL2, with zero runtime errors in those checks;
- cargo/progress/settings after reload, chart input gating, pause, resizing, camera modes and New Game;
- opening, bridge, gorge and lake screenshots.

The opening 10-15 minutes carry the detail. A wide flat town floor runs from the weir to the stone bridge (s 0-720) with low wooded hills set well back; about 100 machiya, kura and shops stand three rows deep on both banks, with stone embankments to s 664 and the temple precinct (pagoda, water torii, temple steps) left open. Distant landmarks: a four-tier castle on the left hills (s 520) and a hillside shrine reached by a path of 30 vermilion torii (s 600). Frontage decoration and moving life run the whole stretch: lantern and pennant strings across the canal, koinobori, working boats with boatmen, ducks, koi, egrets, butterflies, bird flocks, kitchen smoke and villagers. Houses mix cream, earthen ochre and apricot plaster, some with bengara red-ochre lattice; the final grade adds gentle vibrance. The Vermilion Bridge is clean, even lacquer. Top speed is about 7.5 m/s (14-15 kn). Later reaches (gorge, lake, mill) were not revisited; one bare far peak behind the castle is still visible when looking sideways across the town.

Water: the planar reflection is sampled projectively at each pixel's screen position (offset by the ripples), which removed a camera-following seam across the river, and contact foam is suppressed around the player's hull (the wake sim provides its foam). Shadows: tree lods and impostor visibility use the player camera (`uViewPos`); impostor cards face the sun in the shadow pass; no screen-space lod dithering; the sun (azimuth 150, elevation 38) runs along the valley. Outer shadow cascades refresh on camera movement, at most one per frame; every shader pipeline is built once behind the title card so nothing compiles mid-voyage.

Balanced at 1920x1080 on the local Apple M5 Pro (timer-driven headless harness): about 54-57 fps while cruising through the town, frame pacing p50 16.8 ms, p99 26 ms, worst frame about 38 ms (it was 120 ms before the pipeline warm-up). Frame cost is dominated by per-object draw submission (resolution made no difference), so small decoration is kept out of the water's planar mirror pass. High is substantially more expensive and is not the recommended preset.

Startup: an ink-and-washi loading screen paints from index.html in about 0.16 s and stays up (with real phase labels) until the whole scene is built and every shader pipeline is warmed, then lifts to reveal the finished valley; no half-built scene is ever shown. All module downloads start in parallel; the vegetation field and leaf atlases ship as bakes; structures and bridges build time-sliced. Time to playable measured about 7.2-7.6 s cold in a fresh headless profile, of which about 3.9 s is GPU shader pipeline compilation (browsers cache compiled pipelines, so repeat visits are faster).

Latest measurements (balanced, 1080p, headless, machine shared with a busy browser): perf-cruise 57.6 fps, pacing p50 19.0 ms, p99 34.0 ms, worst 35.4 ms. The p50 15 ms / p99 22 ms targets are not met.

Bake exports: after a terrain re-bake or a sites change, re-run `node test/harness.mjs vegetation-export --tag=veg-perf --quiet` and `node test/harness.mjs startup-export --query=bakeStartup:1 --tag=startup --timeout=300`.

To regenerate shipped tree and bounce-light captures after material/layout changes, use `node test/harness.mjs startup-export --query=bakeStartup:1 --tag=startup --timeout=300`. Verify reuse with `node test/harness.mjs startup-cache --tag=startup --quiet`. The application accepts both HTTP-decoded gzip responses and raw compressed files.

## Project notes

`ARCHITECTURE.md` describes module boundaries and coordinates. `docs/BRIEF.md` records the Japanese river direction that superseded the original island concept. Rebuild terrain with `npx tsx tools/bake/index.ts`; the shipped bake is already included. `tools/bake-stub-river.ts` is an obsolete development placeholder, not the shipping bake.

The scene uses procedural architecture and boat geometry, photographic PBR textures and instanced vegetation. It is a stylized real-time reconstruction, not a pixel-identical or AAA-photoreal reproduction of the reference screenshot. Audio levels were tested muted; final subjective sound balance and Safari behavior remain unverified.
