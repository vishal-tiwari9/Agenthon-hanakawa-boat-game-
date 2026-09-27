// generic terrain operators: droplet hydraulic erosion, thermal relaxation, strata terracing.

/**
 * droplet hydraulic erosion. hardness (0..1) protects rock walls, flats and pads.
 * deterministic: droplets come from a seeded prng. `startMin` limits where droplets spawn,
 * droplets die (without depositing) once they reach `stopBelow`.
 */
export function erode(h: Float32Array, res: number, hardness: Float32Array, drops: number, seed: number, startMin = 3, stopBelow = 1.2, S = 60) {
  const N = res * res;
  let st = seed >>> 0;
  const rnd = () => {
    st = (st + 0x6d2b79f5) | 0;
    let t = Math.imul(st ^ (st >>> 15), 1 | st);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const starts: number[] = [];
  for (let k = 0; k < N; k++) if (h[k] > startMin && hardness[k] < 0.8) starts.push(k);
  if (!starts.length) return;
  const R = 5;
  const bi: number[] = [], bw: number[] = [];
  let wsum = 0;
  for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const d = Math.hypot(dx, dz);
    if (d <= R) { bi.push(dz * res + dx); const w = 1 - d / R; bw.push(w); wsum += w; }
  }
  for (let q = 0; q < bw.length; q++) bw[q] /= wsum;
  // lague-style parameters expect normalized heights: work in units of S meters
  for (let k = 0; k < N; k++) h[k] /= S;
  const inertia = 0.3, capK = 5, minSlope = 0.01, erodeK = 0.3, depositK = 0.25, evap = 0.01, grav = 4, maxSteps = 64;
  const stop = stopBelow / S;
  const grad = (px: number, pz: number) => {
    const ix = Math.floor(px), iz = Math.floor(pz);
    const u = px - ix, v = pz - iz;
    const k = iz * res + ix;
    const a = h[k], b = h[k + 1], c = h[k + res], d = h[k + res + 1];
    return { gx: (b - a) * (1 - v) + (d - c) * v, gz: (c - a) * (1 - u) + (d - b) * u, h: a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v };
  };
  for (let n = 0; n < drops; n++) {
    const k0 = starts[Math.floor(rnd() * starts.length)];
    let px = (k0 % res) + rnd(), pz = Math.floor(k0 / res) + rnd();
    let dx = 0, dz = 0, speed = 1, water = 1, sed = 0;
    for (let step = 0; step < maxSteps; step++) {
      const ix = Math.floor(px), iz = Math.floor(pz);
      if (ix < R + 1 || iz < R + 1 || ix >= res - R - 2 || iz >= res - R - 2) break;
      const cell = iz * res + ix;
      const g = grad(px, pz);
      dx = dx * inertia - g.gx * (1 - inertia);
      dz = dz * inertia - g.gz * (1 - inertia);
      const l = Math.hypot(dx, dz);
      if (l < 1e-9) break;
      dx /= l; dz /= l;
      const ox = px, oz = pz;
      px += dx; pz += dz;
      const nx = Math.floor(px), nz = Math.floor(pz);
      if (nx < R + 1 || nz < R + 1 || nx >= res - R - 2 || nz >= res - R - 2) break;
      const g2 = grad(px, pz);
      if (g2.h < stop) break;
      const dh = g2.h - g.h;
      const cap = Math.max(-dh, minSlope) * speed * water * capK;
      if (sed > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * depositK;
        const u = ox - ix, v = oz - iz;
        sed -= amt;
        h[cell] += amt * (1 - u) * (1 - v);
        h[cell + 1] += amt * u * (1 - v);
        h[cell + res] += amt * (1 - u) * v;
        h[cell + res + 1] += amt * u * v;
      } else {
        const amt = Math.min((cap - sed) * erodeK * (1 - hardness[cell]), -dh);
        for (let q = 0; q < bi.length; q++) {
          const t = cell + bi[q];
          const w = amt * bw[q];
          h[t] -= w;
          sed += w;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * -grav));
      water *= 1 - evap;
    }
  }
  for (let k = 0; k < N; k++) h[k] *= S;
}

/** thermal relaxation toward a talus angle (tan), masked */
export function thermal(h: Float32Array, res: number, mask: Float32Array, tanAngle: number, iterations: number) {
  const maxd = (tanAngle * 2048) / res;
  const nb = [1, -1, res, -res];
  for (let it = 0; it < iterations; it++) {
    for (let j = 1; j < res - 1; j++) {
      for (let i = 1; i < res - 1; i++) {
        const k = j * res + i;
        const m = mask[k];
        if (m <= 0.01) continue;
        let best = 0, bk = -1;
        for (const o of nb) {
          const d = h[k] - h[k + o];
          if (d > best) { best = d; bk = k + o; }
        }
        if (bk >= 0 && best > maxd) {
          const mv = (best - maxd) * 0.5 * m;
          h[k] -= mv;
          h[bk] += mv;
        }
      }
    }
  }
}

/** soft strata terracing: benches of thickness L, blended by w (0..1) */
export function terraceValue(v: number, L: number, sharp: number) {
  const t = v / L;
  const f = t - Math.floor(t);
  const g = f < 0.5 - sharp ? 0 : f > 0.5 + sharp ? 1 : ((f - 0.5 + sharp) / (2 * sharp)) ** 2 * (3 - 2 * ((f - 0.5 + sharp) / (2 * sharp)));
  return (Math.floor(t) + g) * L;
}
