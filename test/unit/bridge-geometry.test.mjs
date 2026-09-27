import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';

const { buildStone } = await tsImport('../../src/bridges/stone.ts', import.meta.url);
const { BRIDGES } = await tsImport('../../src/world/layout.ts', import.meta.url);

test('stone bridge cutwaters and arch masonry have finite geometry', () => {
  const ctx = { world: { heightAt: () => 1.5, meta: { extra: { terrain: { abutments: { 'stone-bridge': 1.5 } } } } } };
  const { site } = buildStone(ctx, BRIDGES.find(b => b.id === 'stone-bridge'));
  for (const [name, geo] of site.geos) {
    for (const key of ['pos', 'nor', 'uv']) assert.ok(geo[key].every(Number.isFinite), `${name}.${key} must be finite`);
  }
});
