import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displacement, invertRest, waterHeight, sampleWater, MAX_WAVE_HEIGHT } from '../../src/world/waves.ts';

test('inverse rest point lands on the queried world position', () => {
  const d = [0, 0, 0], r = [0, 0];
  for (const [x, z, t] of [[0, 0, 0], [123.4, -56.7, 17.3], [-800, 640, 9999.5]]) {
    invertRest(x, z, t, r, 5);
    displacement(r[0], r[1], t, d);
    assert.ok(Math.abs(r[0] + d[0] - x) < 1e-4 && Math.abs(r[1] + d[2] - z) < 1e-4);
  }
});

test('height stays within the analytic bound and matches the full sample', () => {
  const s = {};
  for (let i = 0; i < 200; i++) {
    const x = Math.sin(i) * 700, z = Math.cos(i * 1.3) * 700, t = i * 0.37;
    const h = waterHeight(x, z, t);
    assert.ok(Math.abs(h) <= MAX_WAVE_HEIGHT + 1e-9);
    sampleWater(x, z, t, s);
    assert.ok(Math.abs(s.height - h) < 2e-3);
    assert.ok(s.ny > 0.9);
  }
});

test('vertical particle velocity matches finite differences of the rest-point motion', () => {
  const s = {}, a = [0, 0, 0], b = [0, 0, 0], r = [0, 0];
  const t = 42.1, e = 1e-4;
  invertRest(10, 20, t, r, 6);
  displacement(r[0], r[1], t - e, a);
  displacement(r[0], r[1], t + e, b);
  sampleWater(10, 20, t, s);
  assert.ok(Math.abs((b[1] - a[1]) / (2 * e) - s.vy) < 1e-3);
});
