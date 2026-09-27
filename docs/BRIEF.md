# Hanakawa: creative brief (v2, replaces the island concept)

The user rejected the island archipelago. Their words: "I asked for a game VERY SIMILAR TO THIS SCREENSHOT (docs/ref1-presence.png), basically eye pleasing, where there is land on the left and right and we go along it, and everything looks super nice with nature and everything, buildings, bridges, HYPER REALISM ... better graphics and more optimization, with good weather."

Their follow-up choices:
- **Setting:** Japanese, like the screenshot: red arched bridges, a five-storey pagoda, shrines and torii, cherry blossoms, pine/cedar-covered hills, stone lanterns, a riverside village.
- **Weather:** sunny with soft river mist: warm sun, blue sky with soft clouds, light mist lying over the water; bright but atmospheric. NOT the dark, grey, desaturated grade of the screenshot.
- **Boat:** a long traditional wooden Japanese river boat with a curved woven canopy (like the screenshot), with a small quiet engine so it still handles well.
- **Gameplay:** light objectives: a few deliveries between river landings, landmarks to discover, finish/paint unlocks, but mostly relaxing cruising.

## What the screen should look like

Open `docs/ref1-presence.png`. Reproduce its composition and realism: the camera behind and above the boat, looking along a calm river that curves ahead; tall natural grass clumps and pebbly banks on both sides; a vermilion arched bridge spanning the river with wooden piers; a pagoda on the right bank beyond; a small shrine and stone lantern on the left bank; forested hills rising steeply on both sides (dense conifers, a few deciduous trees, pink cherry trees near the water and buildings); the water a near-mirror reflecting the bridge, trees and sky, broken by gentle ripples and the boat's wake; low mist over the water in the distance; cherry petals drifting in the air and floating on the water; birds far off in the sky.

Then change the weather: a clear, sunny late morning (sun ~36 deg up from the east-south-east), blue sky with soft white clouds, warm sunlight raking across the valley, crisp shadows under the bridge and trees, soft white mist lying low on the water mostly in the distance and in the gorge, sky-blue haze separating the far hills. Bright, clean, alive, hyper-real: think a high-end Unreal Engine 5 / RDR2-grade real-time render of a Japanese river on a spring morning.

Palette (display-referred): sky #4a93d8 zenith to #cfe3f2 horizon; conifers deep green #2f4a2c to sunlit #5d7f3c; grass fresh #7fae45 to #a3c65a with straw tips; cherry blossom #f2c4d2 to #e89ab5; vermilion lacquer #c8452c; dark timber #3b2a1e; white plaster #ece6d8; roof tiles charcoal-grey #4a4f55; river water jade/teal #2f6f6a in the body, near-mirror sky reflections, pebbles visible at the clear shallow edges. No gray wash, no crushed blacks, no neon, no heavy bloom, no chromatic aberration, no film grain, no permanent depth of field.

## The river (see `src/world/layout.ts`)

A 2.1 km navigable river through a Japanese valley, from an old weir (downstream, south, s = 0) up to Hanakawa Falls (upstream, north). Width 26-46 m, widening into a lake (~170 m) near the top. Along the way (s = meters from the weir):

- s ~60-330 **Hanakawa village**: timber machiya houses with white plaster, dark wood lattice and grey kawara tile roofs; stone embankment walls (ishigaki) with steps down to the water; the player's starting landing (s 190, left bank); moored small wooden boats; paper lanterns; cherry trees.
- s 272 **riverside shrine** (left bank) with stone lanterns; s 300 **Vermilion Bridge** (the screenshot's bridge); s 392 **five-storey pagoda** on a terrace (right bank); s 440 **water torii** standing in the shallows; s 452 temple steps landing.
- s 680 **stone arch "spectacles" bridge**.
- s ~820-1180 **bamboo gorge**: narrower, rocky banks, mossy boulders, steep cedar slopes, bamboo groves; s 960 **Maiden Falls**, a small cascade entering from the left; s 1080 **covered wooden bridge** high over the gorge.
- s 1380 **Heron footbridge** (simple plank bridge).
- s ~1550-1880 **the lake**: lotus/water lilies and reeds in the margins; s 1702 **lakeside teahouse** on stilts over the water with its landing.
- s 1992 **water mill** with a turning wheel and its landing; s 2119 **Hanakawa Falls** closing the valley.

Hills rise 60-180 m on both sides, mostly forested; meadows and grassy banks along the water; distant blue mountain ridges beyond. The valley walls naturally limit the view, which is the main optimization lever: aggressive distance culling, LOD and impostors for the forest.

## Quality bar

The user was unhappy with the first look ("graphics seem shit"). Every owner must screenshot their work in context, compare with `docs/ref1-presence.png`, and keep iterating until it would pass for a real-time AAA render. Performance matters too: balanced preset 60 fps at 1920x1080 on this Apple M5 Pro, measured, not claimed.

## Original brief

The user's original long brief (the "Luma Coast" archipelago text) is superseded wherever it conflicts with the above (islands, sea, ocean swell, lighthouse, harbor, motor launch). Still valid from it: TypeScript + Vite + three.js WebGPURenderer + TSL + Rapier; WebGL2 fallback; physically based lighting with one tone mapping; planar reflections; caustics only in sunlit shallows; a real boat wake that disperses in world space; custom buoyancy with 12-16 samples, drag, propulsion and flow-dependent steering; fixed timestep with interpolation; follow camera (FOV ~60) with mouse orbit, helm view, photo camera; W/S, A/D, mouse, C, E, M, Esc controls; small elegant UI; spatial audio initialized after first interaction; loading screen, pause/settings, volume, quality presets, local saves; test starting, steering, reversing, docking, collisions, objectives, save/reload, resize and both backends.
