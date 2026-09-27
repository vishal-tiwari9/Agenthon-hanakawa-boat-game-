// paint and trim schemes come from the boat model; this reads them defensively and ties them to
// objectives. the model may publish its list in several places while it is being built, and ids
// the game expects may be missing, so every lookup has a fallback.
import type { GameContext } from '../core/context';
import type { ObjectiveDef } from './types';

export interface PaintInfo {
  id: string;
  name: string;
  swatch: string;
  trim: string;
  /** optional unlock hint from the model (an objective id or free text) */
  unlock?: string;
}

// swatches for the ids the brief names; used when the model does not describe its colors
const KNOWN: Record<string, { name: string; swatch: string; trim: string }> = {
  natural: { name: 'Natural Cedar', swatch: '#a8845a', trim: '#5b4330' },
  dark: { name: 'Smoked Timber', swatch: '#3b2a1e', trim: '#1f1814' },
  vermilion: { name: 'Vermilion Trim', swatch: '#a8845a', trim: '#c8452c' },
  'vermilion-trim': { name: 'Vermilion Trim', swatch: '#a8845a', trim: '#c8452c' },
  reed: { name: 'Reed Canopy', swatch: '#c9b27a', trim: '#5b4330' },
  'canopy-reed': { name: 'Reed Canopy', swatch: '#c9b27a', trim: '#5b4330' },
  indigo: { name: 'Indigo Canopy', swatch: '#2e3f5c', trim: '#a8845a' },
  'canopy-indigo': { name: 'Indigo Canopy', swatch: '#2e3f5c', trim: '#a8845a' },
  ivory: { name: 'Ivory', swatch: '#ebe4d2', trim: '#8a5b36' },
};

// used only when the model publishes nothing at all
const FALLBACK_IDS = ['natural', 'vermilion', 'reed', 'dark', 'indigo'];

const FALLBACK: PaintInfo[] = FALLBACK_IDS.map((id) => ({ id, ...KNOWN[id] }));

function toCss(v: unknown): string | null {
  if (typeof v === 'string' && /^#|^rgb|^hsl|^oklch/.test(v)) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return '#' + (v >>> 0).toString(16).padStart(6, '0').slice(-6);
  if (v && typeof v === 'object' && 'getHexString' in (v as any)) return '#' + (v as any).getHexString();
  return null;
}

function titleCase(id: string) {
  return id.split(/[-_ ]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** find the model's paint list wherever it is published; null when nothing is available yet */
export function readModelPaints(ctx: GameContext): PaintInfo[] | null {
  const b = ctx.boat as any;
  const sv = ctx.services as any;
  const candidates = [b?.paints, b?.model?.paints, sv.boatPaints, sv.boatModelInstance?.paints, sv.boatModel?.paints, sv.boat?.paints];
  const list = candidates.find((c) => Array.isArray(c) && c.length && c.every((p: any) => p && typeof p.id === 'string'));
  if (!list) return null;
  return list.map((p: any) => {
    const k = KNOWN[p.id];
    // guess from the name when the model does not describe its colors
    const guess = /vermilion|red/i.test(p.id + p.name) ? KNOWN.vermilion : /indigo|blue/i.test(p.id + p.name) ? KNOWN.indigo : /reed|straw/i.test(p.id + p.name) ? KNOWN.reed : /dark|smoke|black/i.test(p.id + p.name) ? KNOWN.dark : KNOWN.natural;
    const swatch = toCss(p.swatch) ?? toCss(p.hull) ?? toCss(p.color) ?? toCss(p.hullColor) ?? k?.swatch ?? guess.swatch;
    const trim = toCss(p.trim) ?? toCss(p.trimColor) ?? toCss(p.accent) ?? k?.trim ?? guess.trim;
    return { id: p.id, name: typeof p.name === 'string' ? p.name : k?.name ?? titleCase(p.id), swatch, trim, unlock: typeof p.unlock === 'string' ? p.unlock : undefined };
  });
}

export function paintList(ctx: GameContext): PaintInfo[] {
  return readModelPaints(ctx) ?? FALLBACK;
}

export function defaultPaint(list: PaintInfo[]) {
  return (list.find((p) => p.id === 'vermilion') ?? list.find((p) => /^(natural|ivory)$/.test(p.id)) ?? list[0])?.id ?? 'vermilion';
}

/**
 * assign each rewarding objective a paint. precedence: the model's own `unlock` naming an
 * objective, then the objective's exact id, then its '@pattern' preference (matched against id and
 * name), then anything left. paints never assigned and never marked by the model stay free; paints whose
 * model unlock text names nothing we know unlock when the whole voyage is complete.
 */
export function assignRewards(objs: ObjectiveDef[], list: PaintInfo[]) {
  const base = defaultPaint(list);
  const byObjective = new Map<string, string>();
  const taken = new Set<string>([base]);
  const ids = new Set(objs.map((o) => o.id));
  for (const p of list) {
    if (p.unlock && ids.has(p.unlock) && !byObjective.has(p.unlock) && !taken.has(p.id)) {
      byObjective.set(p.unlock, p.id);
      taken.add(p.id);
    }
  }
  const rewarding = objs.filter((o) => o.reward && !byObjective.has(o.id));
  for (const o of rewarding) {
    if (o.reward && !o.reward.startsWith('@') && list.some((p) => p.id === o.reward) && !taken.has(o.reward)) {
      byObjective.set(o.id, o.reward);
      taken.add(o.reward);
    }
  }
  const free = () => list.filter((p) => !taken.has(p.id));
  for (const o of rewarding) {
    if (byObjective.has(o.id)) continue;
    const pool = free();
    const pattern = o.reward?.startsWith('@') && o.reward !== '@any' ? new RegExp(o.reward.slice(1), 'i') : null;
    const pick = (pattern ? pool.find((p) => pattern.test(`${p.id} ${p.name}`)) : null) ?? pool.find((p) => !p.unlock || !ids.has(p.unlock)) ?? pool[0];
    if (pick) {
      byObjective.set(o.id, pick.id);
      taken.add(pick.id);
    }
  }
  // model-marked paints we could not tie to an objective become the voyage-complete reward
  const finale = free().filter((p) => p.unlock).map((p) => p.id);
  const alwaysFree = free().filter((p) => !p.unlock).map((p) => p.id);
  return { base, byObjective, finale, alwaysFree };
}
