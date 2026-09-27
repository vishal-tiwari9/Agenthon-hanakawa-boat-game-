// the journey upstream: a two-step lesson (cast off under the vermilion bridge, come alongside the
// temple steps with the first cargo), then optional deliveries, the lantern run and discoveries.
// pure data; positions come from src/world/layout.ts.
import type { ObjectiveDef } from './types';

export const OBJECTIVES: ObjectiveDef[] = [
  {
    id: 'cast-off', kind: 'passage', bridge: 'red-bridge', intro: true,
    label: 'Lesson', title: 'Cast off',
    summary: 'Slip the lines at the village landing and pass under the Vermilion Bridge.',
  },
  {
    id: 'temple-steps', kind: 'dock', dock: 'temple', intro: true, requires: ['cast-off'],
    label: 'Lesson', title: 'Temple Steps',
    summary: 'Come alongside the temple landing, slowly.',
    reward: '@vermilion|red|lacquer',
  },
  {
    id: 'incense', kind: 'delivery', from: 'village', to: 'temple',
    label: 'Delivery', title: 'Incense for the temple',
    summary: 'Carry incense from the village to Temple Steps.',
    cargo: 'Incense bundles', cargoKind: 'incense',
  },
  {
    id: 'tea', kind: 'delivery', from: 'temple', to: 'teahouse', requires: ['incense'],
    label: 'Delivery', title: 'Tea for the teahouse',
    summary: 'Take tea chests from Temple Steps to the Lakeside Teahouse.',
    cargo: 'Tea chests', cargoKind: 'tea', reward: '@reed|canopy|straw',
  },
  {
    id: 'rice', kind: 'delivery', from: 'teahouse', to: 'mill', requires: ['tea'],
    label: 'Delivery', title: 'Rice for the mill',
    summary: 'Bring rice bales from the teahouse to Mill Landing.',
    cargo: 'Rice bales', cargoKind: 'rice', reward: '@dark|black|sumi',
  },
  {
    id: 'lanterns', kind: 'gates', route: 'lanterns', requires: ['temple-steps'],
    label: 'Lantern run', title: 'Floating lanterns',
    summary: 'Steer between the paper lanterns drifting on the lake.',
    reward: '@indigo|blue|ai',
  },
  {
    id: 'bridges', kind: 'discover', group: 'bridges', requires: ['temple-steps'],
    label: 'Discovery', title: 'Under every bridge',
    summary: 'Pass beneath all four bridges on the river.',
    reward: '@any',
  },
  {
    id: 'landmarks', kind: 'discover', group: 'landmarks', requires: ['temple-steps'],
    label: 'Discovery', title: 'Sights of the valley',
    summary: 'Find the shrine, the pagoda, the falls and the river’s other landmarks.',
    reward: '@any',
  },
];

/** order in which the hud suggests the next optional objective after the lessons */
export const SUGGESTION_ORDER = ['tea', 'rice', 'lanterns', 'bridges', 'landmarks'];

/** docking is offered below this speed (m/s) within DOCK_RANGE meters of the berth */
export const DOCK_MAX_SPEED = 1.2;
export const DOCK_RANGE = 14;
