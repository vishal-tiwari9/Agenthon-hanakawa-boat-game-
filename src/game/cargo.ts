// delivery cargo carried at ANCHORS.cargo, parented to the boat's render root so it rides every
// roll and pitch: incense bundles standing in woven baskets, wooden tea chests, and straw rice bales
// (tawara) tied with rope. the anchor is read from the live boat each time cargo is loaded, since
// the hull spec is being reshaped for the river boat.
import { Color, CylinderGeometry, DoubleSide, Group, LatheGeometry, Mesh, MeshStandardNodeMaterial, TorusGeometry, Vector2, type Object3D } from 'three/webgpu';
import { color, float, fract, hash, mix, sin, uv } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameContext } from '../core/context';
import { ANCHORS } from '../boat/hullSpec';
import type { CargoKind } from './types';

const CHEST = '/assets/game/wooden_crate_02/wooden_crate_02_1k.gltf';
const BASKET = '/assets/game/wicker_basket_02/wicker_basket_02_1k.gltf';

function shadows(o: Object3D) {
  o.traverse((c) => {
    if ((c as Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
}

let straw: MeshStandardNodeMaterial | null = null;
let rope: MeshStandardNodeMaterial | null = null;
let incense: MeshStandardNodeMaterial | null = null;
let band: MeshStandardNodeMaterial | null = null;

function materials() {
  if (!straw) {
    // straw: fine fibers running along the bale with a little color drift between strands
    straw = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0, side: DoubleSide });
    const u = uv();
    const strand = hash(u.x.mul(220).floor());
    const groove = sin(u.x.mul(1382)).mul(0.5).add(0.5);
    const base = mix(color('#b49a62'), color('#d2bd86'), strand);
    straw.colorNode = base.mul(float(0.82).add(groove.mul(0.18))).mul(float(0.94).add(fract(u.y.mul(3.1).add(strand)).mul(0.06)));
    rope = new MeshStandardNodeMaterial({ color: new Color('#8a7447'), roughness: 0.9, metalness: 0 });
    incense = new MeshStandardNodeMaterial({ color: new Color('#5a4631'), roughness: 0.85, metalness: 0 });
    band = new MeshStandardNodeMaterial({ color: new Color('#b8432d'), roughness: 0.7, metalness: 0 });
  }
  return { straw: straw!, rope: rope!, incense: incense!, band: band! };
}

/** a rice bale: a straw cylinder with swelling sides and flat woven lids, tied with three ropes */
function riceBale() {
  const m = materials();
  const L = 0.74, R = 0.2;
  const prof: Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const y = -L / 2 + t * L;
    const r = R * (0.86 + 0.14 * Math.sin(t * Math.PI));
    prof.push(new Vector2(r, y));
  }
  const g = new Group();
  const body = new Mesh(new LatheGeometry(prof, 28), m.straw);
  g.add(body);
  for (const e of [-1, 1]) {
    const lid = new Mesh(new CylinderGeometry(R * 0.9, R * 0.9, 0.03, 28), m.straw);
    lid.position.y = e * (L / 2 + 0.005);
    g.add(lid);
  }
  for (const y of [-0.22, 0, 0.22]) {
    const r = new Mesh(new TorusGeometry(R * (0.86 + 0.14 * Math.sin((y / L + 0.5) * Math.PI)) + 0.006, 0.011, 6, 32), m.rope);
    r.rotation.x = Math.PI / 2;
    r.position.y = y;
    g.add(r);
  }
  // lie along the boat
  g.rotation.x = Math.PI / 2;
  const holder = new Group();
  holder.add(g);
  holder.position.y = R * 0.95;
  shadows(holder);
  return holder;
}

/** a tied bundle of incense sticks with a vermilion paper band */
function incenseBundle(seed: number) {
  const m = materials();
  const sticks: CylinderGeometry[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + seed, r = i ? 0.012 : 0;
    sticks.push(new CylinderGeometry(0.0035, 0.0035, 0.3, 4).translate(Math.cos(a) * r, 0.15, Math.sin(a) * r) as CylinderGeometry);
  }
  const g = new Group();
  const sg = mergeGeometries(sticks.map((s) => s.toNonIndexed()));
  sticks.forEach((s) => s.dispose());
  g.add(new Mesh(sg, m.incense));
  const b = new Mesh(new CylinderGeometry(0.02, 0.02, 0.035, 12), m.band);
  b.position.y = 0.12;
  g.add(b);
  return g;
}

export class Cargo {
  readonly group = new Group();
  private chest: Object3D | null = null;
  private basket: Object3D | null = null;
  private kind: CargoKind | null = null;
  private loads = new Map<string, Promise<void>>();

  constructor(private ctx: GameContext) {
    this.group.name = 'cargo';
    this.group.visible = false;
  }

  private ensure(kind: CargoKind) {
    const url = kind === 'tea' ? CHEST : kind === 'incense' ? BASKET : null;
    if (!url) return Promise.resolve();
    let p = this.loads.get(url);
    if (!p) {
      p = this.ctx.assets.gltf(url).then((g) => {
        if (url === CHEST) this.chest = g.scene;
        else {
          // the basket ships with its lid propped beside it; carry it open with the bundles showing
          const base = g.scene.getObjectByName('wicker_basket_02_base') ?? g.scene;
          this.basket = base;
        }
        shadows(g.scene);
      }).catch((e) => console.warn('[game] cargo model failed to load', url, e));
      this.loads.set(url, p);
    }
    return p;
  }

  private build() {
    this.group.clear();
    const kind = this.kind;
    if (!kind) return;
    const a = (this.ctx.boat?.anchors?.cargo as typeof ANCHORS.cargo | undefined) ?? ANCHORS.cargo;
    const put = (o: Object3D, x: number, z: number, yaw = 0, y = 0) => {
      o.position.set(a.x + x, a.y + y, a.z + z);
      o.rotation.y += yaw;
      this.group.add(o);
    };
    if (kind === 'tea' && this.chest) {
      for (const [x, yaw] of [[-0.19, 0.03], [0.2, -0.05]] as const) {
        const c = this.chest.clone(true);
        c.scale.setScalar(0.64);
        put(c, x, 0.02, yaw);
      }
    } else if (kind === 'incense' && this.basket) {
      [[-0.2, -0.08], [0.2, 0.1]].forEach(([x, z], k) => {
        const b = new Group();
        const shell = this.basket!.clone(true);
        shell.position.set(0, 0, 0);
        shell.rotation.set(0, 0, 0);
        shell.scale.setScalar(1.8);
        b.add(shell);
        for (let i = 0; i < 7; i++) {
          const ang = (i / 7) * Math.PI * 2 + k, r = i ? 0.09 : 0;
          const bundle = incenseBundle(i + k * 3);
          bundle.position.set(Math.cos(ang) * r, 0.05, Math.sin(ang) * r);
          bundle.rotation.set(Math.sin(i * 2.1) * 0.12, 0, Math.cos(i * 1.7) * 0.12);
          b.add(bundle);
        }
        put(b, x, z, k * 0.4);
      });
    } else if (kind === 'rice') {
      put(riceBale(), -0.2, 0.02, 0.02);
      put(riceBale(), 0.2, -0.03, -0.03);
      put(riceBale(), 0, 0, 0.05, 0.36);
    }
  }

  /** load cargo of a kind aboard (null unloads) */
  set(kind: CargoKind | null) {
    this.kind = kind;
    this.group.visible = !!kind;
    if (!kind) {
      this.group.clear();
      return;
    }
    this.build();
    void this.ensure(kind).then(() => { if (this.kind === kind) this.build(); });
  }

  get aboard() {
    return this.group.children.length;
  }

  /** keep the cargo on whatever render root the boat currently uses */
  update() {
    const root = this.ctx.boat?.object;
    if (root && this.group.parent !== root) root.add(this.group);
  }
}
