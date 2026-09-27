// published shapes (ctx.services.bridges) for gameplay, audio and the water owner.

export interface BridgeInfo {
  id: string;
  name: string;
  type: string;
  s: number;
  /** deck ends (world x, y, z): left bank end, right bank end */
  a: [number, number, number];
  b: [number, number, number];
  /** deck top at the channel center */
  deckY: number;
  /** clear height under the structure at the channel center */
  clearance: number;
  deckWidth: number;
  /** pier / bent centers in the water (world x, z) */
  piers: [number, number][];
  /** navigable openings between piers: ends (world x, z) and their minimum clear height */
  channel: { a: [number, number]; b: [number, number]; clearance: number }[];
}

export interface LandingInfo {
  id: string;
  name: string;
  /** boat hull center and bow heading when moored (from DOCKS) */
  moorX: number;
  moorZ: number;
  headingDeg: number;
  deckY: number;
  /** mooring post tops for the bow and stern lines (world) */
  bow: [number, number, number];
  stern: [number, number, number];
  /** deck outer edge line (world x, z) */
  edge: [[number, number], [number, number]];
  /** top of the steps up to the bank, where a walker would step ashore */
  ashore: [number, number, number];
}

export interface PlatformInfo {
  id: string;
  /** small timber landing platforms along the village embankment: center, deck height, heading along the bank */
  x: number;
  z: number;
  y: number;
  headingDeg: number;
}

export interface LanternInfo {
  x: number;
  y: number;
  z: number;
  kind: 'hanging' | 'post';
}

export interface WeirInfo {
  /** crest line ends (world x, y, z); water spills downstream over it */
  crest: [[number, number, number], [number, number, number]];
  /** unit downstream direction (world x, z) */
  downstream: [number, number];
  /** apron: meters it runs downstream from the crest and its foot height */
  apronLength: number;
  apronFootY: number;
}

export interface BridgesService {
  bridges: BridgeInfo[];
  landings: Record<string, LandingInfo>;
  platforms: PlatformInfo[];
  lanterns: LanternInfo[];
  weir: WeirInfo | null;
  /** village embankment runs: bank side and along-river extent */
  embankments: { side: -1 | 1; s0: number; s1: number }[];
  stats(): { sites: number; visible: number; triangles: number; colliders: number; ms: number };
}
