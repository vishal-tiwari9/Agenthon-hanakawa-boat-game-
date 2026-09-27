// procedural foliage atlases painted on a canvas at load time (srgb, straight alpha).
// the blossom and maple atlases reuse the leaf-card layout of the island_tree leaf atlas (LEAF_RECTS),
// so the decimated trees' leaf quads become cherry blossom sprays or maple leaf clusters without
// touching their uvs. bamboo gets its own spray atlas.
import { CanvasTexture, LinearMipmapLinearFilter, SRGBColorSpace, ClampToEdgeWrapping, type Texture } from 'three/webgpu';

/** leaf rectangles in the island_tree leaf atlas, image space (y down): x0, y0, x1, y1. stem at y1 */
export const LEAF_RECTS: [number, number, number, number][] = [
  [0.0166, 0.0205, 0.1455, 0.5107],
  [0.165, 0.0205, 0.3369, 0.3916],
  [0.6943, 0.0205, 0.8154, 0.4141],
  [0.3613, 0.0313, 0.4824, 0.3613],
  [0.5176, 0.0498, 0.6494, 0.3623],
  [0.2168, 0.5771, 0.3545, 1.0],
  [0.4229, 0.6025, 0.5615, 1.0],
  [0.0176, 0.6299, 0.1816, 1.0],
];

type Ctx2D = CanvasRenderingContext2D;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296;
}

function canvas(size: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, size, size);
  return { c, g };
}

function toTexture(c: HTMLCanvasElement): Texture {
  // spread opaque colour into transparent texels so mipmaps do not pull edges toward black
  const g = c.getContext('2d')!;
  const img = g.getImageData(0, 0, c.width, c.height);
  bleed(img.data, c.width, c.height);
  g.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.flipY = false;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function bleed(d: Uint8ClampedArray, w: number, h: number) {
  let filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = d[i * 4 + 3] > 96 ? 1 : 0;
  let next = filled.slice();
  for (let pass = 0; pass < 10; pass++) {
    next.set(filled);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (filled[i]) continue;
      let r = 0, gg = 0, b = 0, n = 0;
      // right, left, down, up (same order and arithmetic as before, without per-pixel allocations)
      if (x + 1 < w && filled[i + 1]) { const j = (i + 1) * 4; r += d[j]; gg += d[j + 1]; b += d[j + 2]; n++; }
      if (x > 0 && filled[i - 1]) { const j = (i - 1) * 4; r += d[j]; gg += d[j + 1]; b += d[j + 2]; n++; }
      if (y + 1 < h && filled[i + w]) { const j = (i + w) * 4; r += d[j]; gg += d[j + 1]; b += d[j + 2]; n++; }
      if (y > 0 && filled[i - w]) { const j = (i - w) * 4; r += d[j]; gg += d[j + 1]; b += d[j + 2]; n++; }
      if (n) { d[i * 4] = r / n; d[i * 4 + 1] = gg / n; d[i * 4 + 2] = b / n; next[i] = 1; }
    }
    const t = filled; filled = next; next = t;
  }
}

const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h.toFixed(1)},${(s * 100).toFixed(1)}%,${(l * 100).toFixed(1)}%,${a})`;

/** one five-petal cherry blossom (somei-yoshino: near white with a pink blush toward the centre) */
function blossom(g: Ctx2D, x: number, y: number, r: number, rot: number, tone: number, shade: number, tilt: number) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.scale(1, tilt);
  for (let p = 0; p < 5; p++) {
    g.save();
    g.rotate((p / 5) * Math.PI * 2);
    const grad = g.createLinearGradient(0, 0, 0, -r);
    grad.addColorStop(0, hsl(340 + tone * 6, 0.62, 0.66 * shade));
    grad.addColorStop(0.45, hsl(345, 0.55, 0.84 * shade));
    grad.addColorStop(1, hsl(350, 0.45, 0.93 * shade));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 0);
    // rounded petal with the characteristic notch at the tip
    g.bezierCurveTo(-r * 0.62, -r * 0.35, -r * 0.55, -r * 1.02, -r * 0.14, -r * 0.98);
    g.lineTo(0, -r * 0.84);
    g.lineTo(r * 0.14, -r * 0.98);
    g.bezierCurveTo(r * 0.55, -r * 1.02, r * 0.62, -r * 0.35, 0, 0);
    g.fill();
    g.restore();
  }
  // eye: deep pink centre and stamens
  g.fillStyle = hsl(345, 0.6, 0.45 * shade);
  g.beginPath();
  g.arc(0, 0, r * 0.2, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = hsl(40, 0.55, 0.62 * shade, 0.9);
  g.lineWidth = Math.max(0.6, r * 0.05);
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.cos(a) * r * 0.42, Math.sin(a) * r * 0.42);
    g.stroke();
  }
  g.restore();
}

/** cherry blossom sprays in every leaf rect: a dark twig with dense clusters of flowers and a few young leaves */
export function blossomAtlas(size = 1024): Texture {
  const { c, g } = canvas(size);
  const rnd = rng(1177);
  for (const [x0, y0, x1, y1] of LEAF_RECTS) {
    const X0 = x0 * size, Y0 = y0 * size, W = (x1 - x0) * size, H = (y1 - y0) * size;
    g.save();
    g.beginPath();
    g.rect(X0, Y0, W, H);
    g.clip();
    const cx = X0 + W / 2;
    // twig from the stem end (bottom) toward the tip
    g.strokeStyle = '#3a2620';
    g.lineWidth = Math.max(2, W * 0.035);
    g.beginPath();
    g.moveTo(cx, Y0 + H);
    g.quadraticCurveTo(cx + W * 0.12, Y0 + H * 0.5, cx - W * 0.05, Y0 + H * 0.08);
    g.stroke();
    // young bronze-green leaves peeking out
    for (let k = 0; k < 3; k++) {
      const ly = Y0 + H * (0.25 + rnd() * 0.6), lx = cx + (rnd() - 0.5) * W * 0.5;
      g.fillStyle = hsl(75 + rnd() * 25, 0.45, 0.32 + rnd() * 0.1);
      g.beginPath();
      g.ellipse(lx, ly, W * 0.07, H * 0.06, rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    // flowers, back to front: back ones darker (self shadowed), front ones brighter
    const n = Math.round(26 + (W * H) / (size * size) * 900);
    const r = Math.min(W, H) * 0.16;
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const along = rnd();
      const px = cx + (rnd() - 0.5) * W * 0.95 + Math.sin(along * 3) * W * 0.05;
      const py = Y0 + H * (0.04 + along * 0.9);
      const shade = 0.72 + 0.28 * t;
      blossom(g, px, py, r * (0.75 + rnd() * 0.45), rnd() * 6.3, rnd(), shade, 0.55 + rnd() * 0.45);
      // a few closed pink buds
      if (rnd() < 0.12) {
        g.fillStyle = hsl(342, 0.6, 0.62);
        g.beginPath();
        g.ellipse(px + r * 0.9, py - r * 0.4, r * 0.22, r * 0.3, rnd(), 0, Math.PI * 2);
        g.fill();
      }
    }
    g.restore();
  }
  return toTexture(c);
}

/** japanese maple: clusters of small palmate leaves, crimson to orange */
export function mapleAtlas(size = 1024): Texture {
  const { c, g } = canvas(size);
  const rnd = rng(4242);
  const leaf = (x: number, y: number, r: number, rot: number, col: string) => {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.fillStyle = col;
    g.beginPath();
    const lobes = 7;
    for (let i = 0; i <= lobes * 2; i++) {
      // deeply cut palmate outline: long pointed lobes with narrow sinuses
      const a = -Math.PI / 2 + ((i / (lobes * 2)) - 0.5) * Math.PI * 1.7;
      const tip = i % 2 === 0;
      const rr = tip ? r * (1 - Math.abs(i / (lobes * 2) - 0.5) * 0.7) : r * 0.32;
      g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(60,10,5,0.35)';
    g.lineWidth = Math.max(0.6, r * 0.04);
    g.beginPath();
    g.moveTo(0, r * 0.35);
    g.lineTo(0, 0);
    g.stroke();
    g.restore();
  };
  for (const [x0, y0, x1, y1] of LEAF_RECTS) {
    const X0 = x0 * size, Y0 = y0 * size, W = (x1 - x0) * size, H = (y1 - y0) * size;
    g.save();
    g.beginPath();
    g.rect(X0, Y0, W, H);
    g.clip();
    const r = Math.min(W, H) * 0.36;
    const n = Math.round(H / (r * 0.9)) + 1;
    for (let k = 0; k < n; k++) {
      const hue = 2 + rnd() * 26;
      const col = hsl(hue, 0.78, 0.3 + rnd() * 0.16 + (hue > 18 ? 0.06 : 0));
      leaf(X0 + W * (0.3 + rnd() * 0.4), Y0 + H * ((k + 0.5) / n), r * (0.8 + rnd() * 0.35), (rnd() - 0.5) * 1.2, col);
    }
    g.restore();
  }
  return toTexture(c);
}

/** bamboo: four sprays of narrow drooping leaves on thin branchlets, one per quadrant; stem at the bottom */
export function bambooAtlas(size = 512): Texture {
  const { c, g } = canvas(size);
  const rnd = rng(8080);
  const q = size / 2;
  for (let s = 0; s < 4; s++) {
    const ox = (s % 2) * q, oy = Math.floor(s / 2) * q;
    g.save();
    g.beginPath();
    g.rect(ox, oy, q, q);
    g.clip();
    const bx = ox + q * 0.5, by = oy + q * 0.98;
    g.strokeStyle = '#6f7a3a';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(bx, by);
    g.quadraticCurveTo(bx + q * 0.05, oy + q * 0.5, bx - q * 0.05, oy + q * 0.1);
    g.stroke();
    const leaves = 9 + Math.floor(rnd() * 4);
    for (let k = 0; k < leaves; k++) {
      const t = 0.1 + (k / leaves) * 0.8;
      const px = bx + (rnd() - 0.5) * q * 0.1, py = oy + q * (1 - t * 0.9);
      const side = k % 2 ? 1 : -1;
      const ang = side * (0.5 + rnd() * 0.7) + Math.PI / 2 - 0.2;
      const L = q * (0.28 + rnd() * 0.16), Wd = L * 0.13;
      g.save();
      g.translate(px, py);
      g.rotate(ang);
      const grad = g.createLinearGradient(0, 0, L, 0);
      const hue = 78 + rnd() * 16;
      grad.addColorStop(0, hsl(hue, 0.42, 0.3));
      grad.addColorStop(1, hsl(hue + 6, 0.5, 0.42 + rnd() * 0.08));
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(L * 0.35, -Wd, L, Wd * 0.4);
      g.quadraticCurveTo(L * 0.35, Wd * 1.2, 0, 0);
      g.fill();
      g.restore();
    }
    g.restore();
  }
  return toTexture(c);
}

/** regions of the garden atlas, image space (y down): x0, y0, x1, y1 */
export const GARDEN_RECTS = {
  /** a hanging willow strand: twig down the middle, top at y0 */
  strand: [0.0, 0.0, 0.25, 1.0] as [number, number, number, number],
  /** a spray of willow leaves for the crown top */
  willowLeaf: [0.27, 0.39, 0.61, 0.73] as [number, number, number, number],
  /** a radial tuft of pine needles */
  needles: [0.27, 0.02, 0.61, 0.36] as [number, number, number, number],
  /** plum blossom sprays: deep pink (beni-ume) and white (haku-ume) */
  plumPink: [0.64, 0.02, 0.98, 0.36] as [number, number, number, number],
  plumWhite: [0.64, 0.39, 0.98, 0.73] as [number, number, number, number],
  /** opaque texels for bark (tinted by vertex colour) */
  bark: [0.3, 0.8, 0.58, 0.96] as [number, number, number, number],
};

/** willow strands, willow leaf sprays, pine needle tufts, plum blossom and a bark swatch in one atlas */
export function gardenAtlas(size = 1024): Texture {
  const { c, g } = canvas(size);
  const rnd = rng(3131);
  const R = (r: [number, number, number, number]) => ({ X0: r[0] * size, Y0: r[1] * size, W: (r[2] - r[0]) * size, H: (r[3] - r[1]) * size });
  const clip = (r: [number, number, number, number]) => { const q = R(r); g.save(); g.beginPath(); g.rect(q.X0, q.Y0, q.W, q.H); g.clip(); return q; };
  const willowLeaf = (x: number, y: number, len: number, wid: number, rot: number, light: number) => {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    const grad = g.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, hsl(82 + rnd() * 6, 0.5, 0.3 + light * 0.1));
    grad.addColorStop(1, hsl(76 + rnd() * 8, 0.58, 0.42 + light * 0.14));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(wid, len * 0.45, 0, len);
    g.quadraticCurveTo(-wid, len * 0.45, 0, 0);
    g.fill();
    g.restore();
  };

  // willow strand: a thin wavy twig with narrow leaves hanging off both sides, denser toward the top
  {
    const q = clip(GARDEN_RECTS.strand);
    for (let strand = 0; strand < 2; strand++) {
      const cx = q.X0 + q.W * (strand ? 0.62 : 0.4);
      g.strokeStyle = 'rgba(86,78,40,0.9)';
      g.lineWidth = Math.max(1, q.W * 0.018);
      g.beginPath();
      for (let k = 0; k <= 40; k++) {
        const t = k / 40, x = cx + Math.sin(t * 9 + strand * 2) * q.W * 0.05, y = q.Y0 + t * q.H;
        if (k) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
      const n = 150;
      for (let k = 0; k < n; k++) {
        const t = Math.pow(rnd(), 0.8);
        const y = q.Y0 + t * q.H * 0.98, x = cx + Math.sin(t * 9 + strand * 2) * q.W * 0.05;
        const side = rnd() < 0.5 ? -1 : 1;
        const len = q.W * (0.16 + rnd() * 0.12) * (1 - t * 0.3);
        willowLeaf(x, y, len, len * 0.14, side * (0.25 + rnd() * 0.45), rnd());
      }
    }
    g.restore();
  }
  // willow leaf spray for the crown
  {
    const q = clip(GARDEN_RECTS.willowLeaf);
    for (let k = 0; k < 90; k++) {
      const x = q.X0 + q.W * (0.1 + rnd() * 0.8), y = q.Y0 + q.H * (0.05 + rnd() * 0.75);
      const len = q.W * (0.14 + rnd() * 0.1);
      willowLeaf(x, y, len, len * 0.14, (rnd() - 0.5) * 1.4, rnd());
    }
    g.restore();
  }
  // pine needles: a radial tuft, dark at the base, lighter blue-green tips
  {
    const q = clip(GARDEN_RECTS.needles);
    const cx = q.X0 + q.W / 2, cy = q.Y0 + q.H / 2;
    for (let k = 0; k < 520; k++) {
      const a = rnd() * Math.PI * 2, r0 = q.W * 0.04 * rnd(), r1 = q.W * (0.3 + rnd() * 0.19);
      const light = rnd();
      g.strokeStyle = hsl(100 + rnd() * 25, 0.34 + rnd() * 0.12, 0.14 + light * 0.2);
      g.lineWidth = Math.max(1, q.W * 0.009);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a + (rnd() - 0.5) * 0.15) * r1, cy + Math.sin(a + (rnd() - 0.5) * 0.15) * r1);
      g.stroke();
    }
    g.restore();
  }
  // plum blossom: a dark zigzag twig with round five-petal flowers and buds
  const plum = (rect: [number, number, number, number], pink: boolean) => {
    const q = clip(rect);
    const pts: [number, number][] = [];
    let x = q.X0 + q.W * 0.15, y = q.Y0 + q.H * 0.88;
    g.strokeStyle = '#2e211c';
    g.lineWidth = Math.max(2, q.W * 0.03);
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += q.W * (0.1 + rnd() * 0.06);
      y -= q.H * (0.08 + rnd() * 0.08) * (k % 2 ? 0.4 : 1.4);
      g.lineTo(x, y);
      pts.push([x, y]);
    }
    g.stroke();
    for (let k = 0; k < 16; k++) {
      const [px, py] = pts[Math.floor(rnd() * pts.length)];
      const fx = px + (rnd() - 0.5) * q.W * 0.2, fy = py + (rnd() - 0.5) * q.H * 0.2, r = q.W * (0.06 + rnd() * 0.03);
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * Math.PI * 2 + rnd();
        g.fillStyle = pink ? hsl(342 + rnd() * 8, 0.62, 0.5 + rnd() * 0.12) : hsl(40, 0.3, 0.9 + rnd() * 0.05);
        g.beginPath();
        g.arc(fx + Math.cos(a) * r * 0.55, fy + Math.sin(a) * r * 0.55, r * 0.5, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = pink ? hsl(335, 0.7, 0.32) : hsl(80, 0.4, 0.5);
      g.beginPath();
      g.arc(fx, fy, r * 0.22, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = hsl(45, 0.7, 0.62, 0.9);
      g.lineWidth = Math.max(0.6, r * 0.05);
      for (let s = 0; s < 8; s++) { const a = rnd() * 6.28; g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx + Math.cos(a) * r * 0.55, fy + Math.sin(a) * r * 0.55); g.stroke(); }
    }
    for (let k = 0; k < 8; k++) {
      const [px, py] = pts[Math.floor(rnd() * pts.length)];
      g.fillStyle = pink ? hsl(338, 0.7, 0.4) : hsl(350, 0.35, 0.78);
      g.beginPath();
      g.ellipse(px + (rnd() - 0.5) * q.W * 0.12, py + (rnd() - 0.5) * q.H * 0.12, q.W * 0.022, q.W * 0.03, rnd() * 3, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  };
  plum(GARDEN_RECTS.plumPink, true);
  plum(GARDEN_RECTS.plumWhite, false);
  // bark swatch: opaque, near white, tinted per vertex
  {
    const q = R(GARDEN_RECTS.bark);
    g.fillStyle = '#e4e0da';
    g.fillRect(q.X0, q.Y0, q.W, q.H);
  }
  return toTexture(c);
}
