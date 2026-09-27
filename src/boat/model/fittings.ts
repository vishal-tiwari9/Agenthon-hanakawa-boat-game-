// fittings for the wasen: wooden mooring bitts, bamboo lantern pole with a paper chochin, the
// engine box with its iron exhaust, the rudder with its raked tiller, propeller, shaft and skeg
// shoe, and coiled straw ropes. rotating parts are built in boat-local coordinates.
import { BufferGeometry, CatmullRomCurve3, LatheGeometry, LineCurve3, Matrix4, Quaternion, TorusGeometry, Vector2, Vector3 } from 'three/webgpu';
import { ANCHORS, HULL, sheerAt, stationAt } from '../hullSpec';
import { W } from './hull';
import { lathe, mirrorX, rawGeo, roundedPoly, roundedPrism, sweep, sweepCaps, tube, withExtra, type Extra, type Frame, type PrismFrame, type Pt } from './geo';
import { LAYOUT, deckY, railTop } from './lines';
import { Parts } from './parts';

const IRON: Extra = { tint: [0.06, 0.055, 0.05], mr: [0.85, 0.62] };
const COPPER: Extra = { tint: [0.5, 0.3, 0.17], mr: [1, 0.45] };
const BRONZE: Extra = { tint: [0.55, 0.37, 0.19], mr: [1, 0.38] };
const alignY = (n: Vector3) => new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), n.clone().normalize());
const compose = (p: Vector3, q: Quaternion) => new Matrix4().compose(p, q, new Vector3(1, 1, 1));
export const SHAFT_DIR = new Vector3(0, -Math.sin((6 * Math.PI) / 180), Math.cos((6 * Math.PI) / 180));

/** a box of timber from y0 to y1 on a plan outline, grain vertical */
function post(parts: Parts, key: string, outline: Pt[], y0: number, y1: number, r: number, seed: number) {
  const b = roundedPrism(roundedPoly(outline, r * 1.5, 2), y0, y1, r, { rings: 1, roundSegs: 3 });
  parts.add(key, withExtra(b.side, W(10, 0, seed)));
  parts.add(key, withExtra(b.top, W(0, 0, seed + 0.5)));
}

const sq = (x: number, z: number, h: number): Pt[] => [[x - h, z - h], [x + h, z - h], [x + h, z + h], [x - h, z + h]];

/** wooden bitt: squared post with a wider mushroom head */
function bitt(parts: Parts, x: number, z: number, base: number, seed: number) {
  post(parts, 'wood', sq(x, z, 0.03), base - 0.02, base + 0.095, 0.006, seed);
  post(parts, 'wood', sq(x, z, 0.043), base + 0.095, base + 0.122, 0.011, seed + 1);
}

// ---------------------------------------------------------------- lantern
export function lanternGeo(full: boolean) {
  // chochin: ribbed paper barrel between lacquered rims, hanging from a short cord
  const out: BufferGeometry[] = [];
  const prof: Pt[] = [];
  const H = 0.34, R = 0.125, n = full ? 24 : 12;
  for (let k = 0; k <= n; k++) {
    const t = k / n, y = -H + H * t;
    const e = (t - 0.5) * 2;
    prof.push([R * Math.sqrt(Math.max(0.02, 1 - e * e * 0.72)), y]);
  }
  out.push(lathe(prof, full ? 40 : 20, { paper: [1] }));
  for (const [y, r] of [[-H, 0.058], [0, 0.058]] as const) {
    out.push(lathe([[0, y - 0.018], [r, y - 0.018], [r + 0.006, y - 0.012], [r + 0.006, y + 0.012], [r, y + 0.018], [0, y + 0.018]], 24, { paper: [0] }));
  }
  // cord and hook
  out.push(lathe([[0.003, 0.018], [0.003, 0.13], [0.0, 0.13]], 6, { paper: [0] }));
  return out;
}

/** bamboo pole on the bow deck with an arm the lantern hangs from; returns the hook point */
function lanternPole(parts: Parts) {
  const z = -2.9, x = 0.0, y0 = deckY(z);
  const rake = new Vector3(0, 1, -0.12).normalize();
  const top = new Vector3(x, y0, z).addScaledVector(rake, 1.78);
  parts.add('bamboo', tube(new LineCurve3(new Vector3(x, y0 - 0.05, z), top), 4, 0.02, 10, { seed: [2.1] }));
  const armEnd = top.clone().add(new Vector3(0, -0.03, -0.36));
  parts.add('bamboo', tube(new CatmullRomCurve3([top.clone().add(new Vector3(0, -0.06, 0.04)), top.clone().add(new Vector3(0, -0.03, -0.12)), armEnd]), 12, 0.012, 8, { seed: [3.7] }));
  // lashing where the arm meets the pole, and a socket block on the deck
  for (let w = 0; w < 3; w++) parts.add('rope', new TorusGeometry(0.024, 0.004, 6, 16).rotateX(Math.PI / 2).translate(top.x, top.y - 0.07 + w * 0.009, top.z));
  post(parts, 'wood', sq(x, z, 0.05), y0 - 0.01, y0 + 0.05, 0.008, 61);
  return armEnd.add(new Vector3(0, -0.008, 0));
}

// ---------------------------------------------------------------- engine box
function engineBox(parts: Parts, full: boolean) {
  const [z0, z1] = LAYOUT.engine;
  const hx = 0.28, yTop = 0.56;
  // side profile with a lid sloping down aft, extruded across the boat (both halves)
  const outline = roundedPoly([[z0, LAYOUT.floorY - 0.01], [z1, LAYOUT.floorY - 0.01], [z1, yTop - 0.05], [z0, yTop]], [0, 0, 0.012, 0.012], 2);
  for (const sx of [1, -1]) {
    const frame: PrismFrame = { origin: new Vector3(), ax: new Vector3(0, 0, 1), ay: new Vector3(0, 1, 0), n: new Vector3(sx, 0, 0) };
    const b = roundedPrism(outline, 0, hx, 0.01, { frame, rings: 1, roundSegs: 3, topUvSwap: true });
    parts.add('wood', withExtra(b.side, W(2, 0.1, 71 + sx)));
    parts.add('wood', withExtra(b.top, W(12, 0.1, 73 + sx)));
  }
  // lid battens
  for (const xb of [-0.2, 0.2]) {
    const frame: PrismFrame = { origin: new Vector3(xb, 0, 0), ax: new Vector3(0, 0, 1), ay: new Vector3(0, 1, 0), n: new Vector3(1, 0, 0) };
    const o = roundedPoly([[z0 - 0.01, yTop - 0.004], [z1 + 0.01, yTop - 0.054], [z1 + 0.01, yTop - 0.03], [z0 - 0.01, yTop + 0.02]], 0.004, 1);
    const b = roundedPrism(o, -0.02, 0.02, 0.004, { frame, rings: 1, roundSegs: 2 });
    parts.add('wood', withExtra(b.side, W(0, 0, 75)));
    parts.add('wood', withExtra(b.top, W(0, 0, 76)));
    parts.add('wood', withExtra(mirrorX(b.top).applyMatrix4(new Matrix4().makeTranslation(2 * xb, 0, 0)), W(0, 0, 76)));
  }
  // iron exhaust stack out of the lid, bent aft, with a rain cap
  const ex = [new Vector3(-0.16, yTop - 0.05, z1 - 0.12), new Vector3(-0.16, yTop + 0.16, z1 - 0.1), new Vector3(-0.16, yTop + 0.25, z1 - 0.03), new Vector3(-0.16, yTop + 0.27, z1 + 0.05)];
  parts.add('metal', tube(new CatmullRomCurve3(ex), 24, 0.022, 12, IRON));
  parts.add('metal', lathe([[0, -0.01], [0.034, -0.01], [0.034, 0.012], [0.026, 0.012], [0, 0.012]], 16, IRON).applyMatrix4(compose(new Vector3(-0.16, yTop - 0.05, z1 - 0.12), new Quaternion())));
  if (full) {
    // cast vent grille on the forward face
    const vf: PrismFrame = { origin: new Vector3(0, 0, z0), ax: new Vector3(1, 0, 0), ay: new Vector3(0, 1, 0), n: new Vector3(0, 0, -1) };
    const plate = roundedPrism(roundedPoly([[-0.12, 0.2], [0.12, 0.2], [0.12, 0.33], [-0.12, 0.33]], 0.01, 2), 0, 0.004, 0.0015, { frame: vf, rings: 1, roundSegs: 2 });
    parts.add('metal', withExtra(plate.side, IRON));
    parts.add('metal', withExtra(plate.top, IRON));
    for (let k = 0; k < 5; k++) {
      const y = 0.215 + k * 0.022;
      const bar = roundedPrism(roundedPoly([[-0.105, y], [0.105, y], [0.105, y + 0.008], [-0.105, y + 0.008]], 0.002, 1), 0.004, 0.009, 0.001, { frame: vf, rings: 1, roundSegs: 2 });
      parts.add('metal', withExtra(bar.top, IRON));
      parts.add('metal', withExtra(bar.side, IRON));
    }
    // lid handle
    parts.add('metal', tube(new CatmullRomCurve3([new Vector3(-0.06, yTop - 0.02, z0 + 0.1), new Vector3(-0.05, yTop + 0.02, z0 + 0.1), new Vector3(0.05, yTop + 0.02, z0 + 0.1), new Vector3(0.06, yTop - 0.02, z0 + 0.1)]), 16, 0.006, 6, IRON));
  }
}

// ---------------------------------------------------------------- rudder + tiller (one pivot)
export function rudderGeo(full: boolean) {
  const parts = new Parts();
  const zr = ANCHORS.rudder.z;
  // wooden blade hung under the stern, balanced a little ahead of the stock
  const blade = roundedPoly([[zr - 0.04, -0.075], [zr + 0.3, -0.075], [zr + 0.32, -0.2], [zr + 0.24, -0.285], [zr - 0.04, -0.285]], [0.01, 0.04, 0.06, 0.03, 0.01], 3);
  const bf: PrismFrame = { origin: new Vector3(), ax: new Vector3(0, 0, 1), ay: new Vector3(0, 1, 0), n: new Vector3(1, 0, 0) };
  const b = roundedPrism(blade, 0, 0.018, 0.006, { frame: bf, rings: 1, roundSegs: 3, topUvSwap: false });
  for (const g of [withExtra(b.side, W(10, 0, 81)), withExtra(b.top, W(12, 0.12, 82))]) {
    parts.add('wood', g);
    parts.add('wood', mirrorX(g));
  }
  // iron straps across the blade
  for (const yy of [-0.12, -0.24]) {
    const st = roundedPrism(roundedPoly([[zr - 0.05, yy], [zr + 0.2, yy], [zr + 0.2, yy + 0.022], [zr - 0.05, yy + 0.022]], 0.004, 1), 0, 0.022, 0.003, { frame: bf, rings: 1, roundSegs: 2 });
    for (const g of [withExtra(st.side, IRON), withExtra(st.top, IRON)]) {
      parts.add('metal', g);
      parts.add('metal', mirrorX(g));
    }
  }
  // stock up through the stern deck, iron band at the head
  post(parts, 'wood', sq(0, zr, 0.028), -0.09, ANCHORS.wheel.y + 0.02, 0.006, 83);
  parts.add('metal', lathe([[0.0, 0], [0.036, 0], [0.036, 0.03], [0, 0.03]], 16, IRON).translate(0, ANCHORS.wheel.y - 0.04, zr));
  // raked tiller: from the head forward and up to the helmsman's hands
  const head = new Vector3(0, ANCHORS.wheel.y - 0.01, zr), grip = new Vector3(0, 1.02, zr - 0.64);
  const tf: Frame[] = [];
  const dir = grip.clone().sub(head).normalize();
  const a = new Vector3(1, 0, 0), bb = new Vector3().crossVectors(dir, a).normalize();
  for (let k = 0; k <= 10; k++) tf.push({ p: head.clone().lerp(grip, k / 10), a: a.clone(), b: bb.clone() });
  const tp: Pt[] = roundedPoly([[-0.02, -0.02], [0.02, -0.02], [0.02, 0.02], [-0.02, 0.02]], 0.008, 2);
  // (a = +x, b, t): a x b = t by construction
  parts.add('wood', sweep(tf, tp, { closedProfile: true, extra: W(0, 0, 85) }).build(false));
  for (const c of sweepCaps(tf, tp, W(0, 0, 86))) parts.add('wood', c);
  if (full) parts.add('rope', tube(new CatmullRomCurve3([grip.clone().addScaledVector(dir, -0.2), grip.clone().addScaledVector(dir, -0.02)]), 8, 0.024, 10));
  return parts;
}

// ---------------------------------------------------------------- running gear
export function propellerGeo(full: boolean) {
  const out: BufferGeometry[] = [];
  const R = 0.1, rh = 0.026, pitch = 0.2;
  const hub = lathe([[0, -0.035], [0.02, -0.035], [0.026, -0.027], [0.027, 0.024], [0.022, 0.04], [0.014, 0.058], [0.005, 0.066], [0, 0.068]], full ? 20 : 10, BRONZE);
  hub.rotateX(Math.PI / 2);
  out.push(hub);
  const nr = full ? 9 : 5, nc = full ? 9 : 5;
  for (let b = 0; b < 3; b++) {
    const base = (b * Math.PI * 2) / 3;
    for (const face of [1, -1]) {
      const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
      for (let i = 0; i <= nr; i++) {
        const tr = i / nr, r = rh * 0.9 + (R - rh * 0.9) * tr;
        const chord = 0.075 * Math.sqrt(Math.max(0.02, 1 - Math.pow(tr * 1.02, 2.4))) * (0.75 + 0.5 * Math.sin(Math.PI * Math.min(1, tr * 1.2)));
        const skew = 0.35 * tr * tr;
        for (let j = 0; j <= nc; j++) {
          const c = -1 + (2 * j) / nc;
          const phi = base + skew + (c * chord * 0.5) / r;
          const th = 0.0055 * (1 - c * c) * (1 - 0.7 * tr) * face;
          pos.push(Math.cos(phi) * r, Math.sin(phi) * r, (-pitch * (phi - base - skew)) / (Math.PI * 2) + th + 0.004);
          uvs.push(tr, c);
        }
      }
      for (let i = 0; i < nr; i++)
        for (let j = 0; j < nc; j++) {
          const a = i * (nc + 1) + j;
          if (face > 0) idx.push(a, a + 1, a + nc + 2, a, a + nc + 2, a + nc + 1);
          else idx.push(a, a + nc + 2, a + 1, a, a + nc + 1, a + nc + 2);
        }
      out.push(withExtra(rawGeo(pos, uvs, idx), BRONZE));
    }
  }
  return out;
}

function runningGear(parts: Parts) {
  const P = ANCHORS.propeller, q = alignY(SHAFT_DIR);
  const back = (3.18 - P.z) / SHAFT_DIR.z;
  parts.add('metal', lathe([[0, 0], [0.012, 0], [0.012, 0.13], [0, 0.13]], 12, BRONZE).applyMatrix4(compose(P.clone().addScaledVector(SHAFT_DIR, back - 0.05), q)));
  parts.add('metal', lathe([[0, 0], [0.026, 0], [0.028, 0.016], [0.022, 0.04], [0.013, 0.046], [0, 0.046]], 14, BRONZE).applyMatrix4(compose(P.clone().addScaledVector(SHAFT_DIR, back - 0.004), q)));
  // iron skeg shoe from the aperture to the rudder heel, with the heel pin
  const shoe = roundedPrism(roundedPoly([[-0.022, 3.08], [0.022, 3.08], [0.022, 3.62], [-0.022, 3.62]], [0, 0, 0.02, 0.02], 2), -HULL.maxDraft, -HULL.maxDraft + 0.016, 0.004, { rings: 1, roundSegs: 2 });
  parts.add('metal', withExtra(shoe.side, IRON));
  parts.add('metal', withExtra(shoe.top, IRON));
  parts.add('metal', lathe([[0, 0], [0.01, 0], [0.01, 0.03], [0, 0.03]], 10, IRON).translate(0, -HULL.maxDraft + 0.014, ANCHORS.rudder.z));
}

// ---------------------------------------------------------------- straw ropes
function coil(cx: number, cz: number, rIn: number, rOut: number, turns: number, start: number, rr: number, yAt: (x: number, z: number) => number) {
  const pts: Vector3[] = [];
  const n = Math.round(turns * 30), tMax = turns * Math.PI * 2;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * tMax, r = rIn + ((rOut - rIn) * t) / tMax, a = start + t;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    pts.push(new Vector3(x, yAt(x, z) + rr * 0.9, z));
  }
  return pts;
}

function ropes(parts: Parts, full: boolean) {
  const rr = 0.009, dy = (_x: number, z: number) => deckY(z);
  // bow line coiled on the bow deck, made fast to the bow bitt
  const bc = ANCHORS.bowCleat, bd = deckY(bc.z);
  const bow = coil(0.1, -2.56, 0.02, 0.12, 4.2, 0.3, rr, dy);
  const bl = bow[bow.length - 1];
  const bowLead = [bl, new Vector3(0.11, bd + 0.03, -2.64), new Vector3(0.045, bd + 0.05, bc.z + 0.02), new Vector3(-0.036, bd + 0.07, bc.z), new Vector3(0.0, bd + 0.08, bc.z - 0.04), new Vector3(0.037, bd + 0.07, bc.z), new Vector3(0.0, bd + 0.06, bc.z + 0.04)];
  parts.add('rope', tube(new CatmullRomCurve3([...bow, ...bowLead.slice(1)], false, 'centripetal'), full ? 300 : 120, rr, full ? 8 : 6));
  // stern line on the port quarter
  const sc = ANCHORS.sternCleatPort, sd = deckY(sc.z);
  const st = coil(-0.2, 3.5, 0.018, 0.1, 3.5, Math.PI, rr, dy);
  const sl = st[st.length - 1];
  const sLead = [sl, new Vector3(sc.x + 0.07, sd + 0.03, sc.z + 0.06), new Vector3(sc.x + 0.035, sd + 0.07, sc.z), new Vector3(sc.x, sd + 0.08, sc.z - 0.04), new Vector3(sc.x - 0.037, sd + 0.07, sc.z), new Vector3(sc.x, sd + 0.06, sc.z + 0.04)];
  parts.add('rope', tube(new CatmullRomCurve3([...st, ...sLead.slice(1)], false, 'centripetal'), full ? 240 : 100, rr, full ? 8 : 6));
}

export interface FittingsOut {
  rudder: Parts;
  propeller: BufferGeometry[];
  lantern: { hook: Vector3; geo: BufferGeometry[] };
}

export function buildFittings(parts: Parts, full: boolean): FittingsOut {
  bitt(parts, ANCHORS.bowCleat.x, ANCHORS.bowCleat.z, deckY(ANCHORS.bowCleat.z), 51);
  for (const sx of [-1, 1]) {
    bitt(parts, sx * Math.abs(ANCHORS.midCleatStarboard.x), ANCHORS.midCleatStarboard.z, railTop(ANCHORS.midCleatStarboard.z) - 0.004, 53 + sx);
    bitt(parts, sx * Math.abs(ANCHORS.sternCleatStarboard.x), ANCHORS.sternCleatStarboard.z, deckY(ANCHORS.sternCleatStarboard.z), 56 + sx);
  }
  const hook = lanternPole(parts);
  engineBox(parts, full);
  runningGear(parts);
  ropes(parts, full);
  return { rudder: rudderGeo(full), propeller: propellerGeo(full), lantern: { hook, geo: lanternGeo(full) } };
}

export { COPPER, LatheGeometry, Vector2, sheerAt, stationAt };
