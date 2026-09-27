// gameplay on the river: a short lesson (cast off from the village and pass under the vermilion
// bridge, then come alongside temple steps with the first cargo), chained deliveries upstream, the
// floating lantern run on the lake, discoveries, finish unlocks and local saves. mostly it stays out
// of the way. publishes ctx.services.game (see ./types) for the interface.
import { Vector3 } from 'three/webgpu';
import type { GameContext } from '../core/context';
import { BRIDGES, DOCKS, POIS, forwardToHeading, nearestRiver, riverFrame, type Dock } from '../world/layout';
import { DOCK_MAX_SPEED, DOCK_RANGE, OBJECTIVES, SUGGESTION_ORDER } from './objectives';
import { NavTable, lanternGates, objectiveReach, type Reach } from './river';
import { LanternRun } from './lanterns';
import { Cargo } from './cargo';
import { clearSave, emptySave, loadSave, writeSave, type ObjectiveSave, type SaveData } from './save';
import { assignRewards, paintList, type PaintInfo } from './paints';
import type { GameService, GatePoint, HintKey, ObjectiveDef, ObjectiveStatus, ObjectiveView, PaintView, PoiView, PromptView, RouteView, TargetView, ToastView } from './types';

export async function init(ctx: GameContext) {
  const game = new Game(ctx);
  await game.init();
  ctx.services.game = game.service;
}

const byId = new Map(OBJECTIVES.map((o) => [o.id, o]));
const dockById = new Map(DOCKS.map((d) => [d.id, d]));
const bridgeById = new Map(BRIDGES.map((b) => [b.id, b]));
const LANDMARK_POIS = POIS.filter((p) => p.kind !== 'bridge');
const BRIDGE_POIS = POIS.filter((p) => p.kind === 'bridge');

/** m/s to the player's units, rounded for copy ("below 2 kn") */
function speedWords(ctx: GameContext, ms: number) {
  return ctx.settings.units === 'kmh' ? `${Math.round(ms * 3.6)} km/h` : `${Math.round(ms * 1.943844)} kn`;
}

interface TimedHint {
  keys: HintKey[];
  until: number;
}

interface RiverPos {
  x: number;
  z: number;
  s: number;
  lateral: number;
  width: number;
}

class Game {
  save: SaveData = emptySave();
  nav: NavTable | null = null;
  lanternRoute: GatePoint[] = [];
  reach = new Map<string, Reach>();
  lanterns: LanternRun;
  cargo: Cargo;
  paints: PaintInfo[] = [];
  rewards!: ReturnType<typeof assignRewards>;
  phase: 'title' | 'playing' = 'title';
  dockedAt: string | null = null;
  private dockedSince = 0;
  private prev: RiverPos | null = null;
  private hint: TimedHint | null = null;
  private hadSave = false;
  service: GameService;

  constructor(private ctx: GameContext) {
    this.lanterns = new LanternRun(ctx);
    this.cargo = new Cargo(ctx);
    const self = this;
    this.service = {
      phase: 'title', hasSave: false, objectives: [], tracked: null, target: null, prompt: null, hints: null,
      cargo: null, dockedAt: null, pois: [], routes: [], paints: [], paint: 'vermilion', allDone: false,
      start: () => self.start(),
      track: (id) => self.track(id),
      selectPaint: (id) => self.selectPaint(id),
      newGame: () => self.newGame(),
      refreshPaints: () => self.refreshPaints(),
    };
    // harness and debugging hooks, not part of the ui contract
    (this.service as any).debug = {
      lanterns: () => this.lanternRoute,
      reach: () => [...this.reach.values()],
      save: () => JSON.parse(JSON.stringify(this.save)),
      complete: (id: string) => { const o = byId.get(id); if (o) this.complete(o); },
    };
  }

  async init() {
    const ctx = this.ctx;
    const sampler = { depth: (x: number, z: number) => ctx.world.depthAt(x, z) };
    // check every objective point is reachable by water from the village landing
    const notes: string[] = [];
    try {
      this.nav = new NavTable(sampler);
      this.lanternRoute = lanternGates(this.nav, sampler, notes);
      for (const r of objectiveReach(this.nav, sampler, DOCK_RANGE)) {
        this.reach.set(r.id, r);
        if (r.note) (r.ok ? console.info : console.warn)('[game]', r.note);
      }
      this.lanternRoute.forEach((g, i) => {
        const r = this.nav!.walk(nearestRiver(DOCKS[0].moorX, DOCKS[0].moorZ).s, 0, g.s ?? 0);
        if (!r.ok) console.warn(`[game] lantern gate ${i + 1}: river blocked at s ${r.at.toFixed(0)}`);
      });
    } catch (e) {
      console.warn('[game] river checks failed', e);
    }
    for (const n of notes) console.info('[game]', n);
    this.lanterns.build(this.lanternRoute);

    this.paints = paintList(ctx);
    this.rewards = assignRewards(OBJECTIVES, this.paints);

    const loaded = loadSave();
    this.hadSave = !!loaded && (Object.keys(loaded.objectives).length > 0 || loaded.discovered.length > 0);
    if (loaded) this.save = loaded;
    this.grantMissedRewards();

    // start moored: at the last landing from the save, otherwise the village
    const start = dockById.get(this.save.dock ?? '') ?? dockById.get('village') ?? DOCKS[0];
    this.moor(start, start.headingDeg, false);
    if (this.save.cargo) this.cargo.set(byId.get(this.save.cargo)?.cargoKind ?? null);
    this.applyPaint();

    ctx.events.on('input:interact', () => this.interact());
    ctx.onUpdate((c) => this.update(c), 15);
    this.publish();
  }

  // ---------------------------------------------------------------- state helpers

  status(o: ObjectiveDef): ObjectiveStatus {
    const s = this.save.objectives[o.id];
    if (s?.status === 'done') return 'done';
    if (o.requires?.some((r) => this.save.objectives[r]?.status !== 'done')) return 'locked';
    return s?.status === 'active' ? 'active' : 'available';
  }

  private open(o: ObjectiveDef | undefined) {
    if (!o) return false;
    const s = this.status(o);
    return s === 'available' || s === 'active';
  }

  private entry(o: ObjectiveDef): ObjectiveSave {
    return (this.save.objectives[o.id] ??= { status: 'active' });
  }

  private persist() {
    writeSave(this.save);
  }

  private play(name: string) {
    try {
      (this.ctx.services.audio as any)?.play?.(name);
    } catch {}
  }

  private toast(t: ToastView) {
    this.ctx.events.emit('game:toast', t);
  }

  private activate(o: ObjectiveDef) {
    if (this.status(o) !== 'available') return;
    this.save.objectives[o.id] = { ...(this.save.objectives[o.id] ?? {}), status: 'active' };
    this.save.focus = o.id;
    this.ctx.events.emit('objective:started', { id: o.id, title: o.title });
  }

  private paintName(id: string) {
    return this.paints.find((p) => p.id === id)?.name ?? id;
  }

  /** rewards for objectives finished before the model published its finish list */
  private grantMissedRewards() {
    for (const [oid, pid] of this.rewards.byObjective) if (this.save.objectives[oid]?.status === 'done' && !this.save.unlocked.includes(pid)) this.save.unlocked.push(pid);
    if (OBJECTIVES.every((o) => this.save.objectives[o.id]?.status === 'done')) for (const pid of this.rewards.finale) if (!this.save.unlocked.includes(pid)) this.save.unlocked.push(pid);
  }

  // every finish is available from the start; objectives no longer gate them
  isUnlocked(_id: string) {
    return true;
  }

  private applyPaint() {
    const id = this.save.paint && this.isUnlocked(this.save.paint) ? this.save.paint : null;
    if (!id) return;
    try {
      this.ctx.boat?.setPaint(id);
    } catch (e) {
      console.warn('[game] setPaint failed', id, e);
    }
  }

  /**
   * mark done and grant the reward. returns the reward line for the toast; `quiet` lets a caller
   * that finishes several objectives at once announce them together.
   */
  private complete(o: ObjectiveDef, quiet = false): string {
    if (this.status(o) === 'done') return '';
    this.save.objectives[o.id] = { status: 'done' };
    if (this.save.focus === o.id) this.save.focus = null;
    this.ctx.events.emit('objective:completed', { id: o.id, title: o.title });
    const line = '';
    if (!quiet) {
      const next = o.id === 'cast-off' ? 'Now bring her alongside Temple Steps.' : '';
      this.toast({ tone: 'complete', eyebrow: o.intro ? 'Lesson complete' : 'Complete', title: o.title, detail: `${line} ${next}`.trim() || undefined });
      this.play('complete');
      this.finale();
      this.evaluate();
      this.persist();
    }
    return line;
  }

  private finale() {
    if (!OBJECTIVES.every((x) => this.status(x) === 'done')) return;
    this.toast({ tone: 'complete', eyebrow: 'Journey complete', title: 'The whole river', detail: 'Drift wherever the light is good.' });
  }

  /** follow-on effects after any change: cargo waiting at this landing, finished discoveries */
  private evaluate() {
    if (this.phase === 'playing' && this.dockedAt) this.loadCargoAt(this.dockedAt);
    for (const o of OBJECTIVES) {
      if (o.kind !== 'discover' || !this.open(o)) continue;
      const list = o.group === 'bridges' ? BRIDGE_POIS : LANDMARK_POIS;
      if (list.every((p) => this.save.discovered.includes(p.id))) this.complete(o);
    }
  }

  private loadCargoAt(dockId: string) {
    if (this.save.cargo) return;
    const o = OBJECTIVES.find((x) => x.kind === 'delivery' && x.from === dockId && this.open(x));
    if (!o) return;
    this.activate(o);
    this.save.cargo = o.id;
    this.cargo.set(o.cargoKind ?? null);
    const to = dockById.get(o.to!);
    this.toast({ tone: 'cargo', eyebrow: 'Cargo loaded', title: o.cargo ?? 'Cargo', detail: `For ${to?.name ?? 'the next landing'}.` });
    this.play('cargo');
    this.persist();
  }

  // ---------------------------------------------------------------- docking

  private moor(d: Dock, headingDeg: number, announce: boolean) {
    const b = this.ctx.boat;
    if (b) {
      try {
        // dockTo springs the hull onto the berth; from farther than a docking approach, place it first
        if (Math.hypot(b.position.x - d.moorX, b.position.z - d.moorZ) > DOCK_RANGE + 6) b.teleport(d.moorX, d.moorZ, headingDeg);
        b.dockTo({ x: d.moorX, z: d.moorZ, headingDeg });
      } catch (e) {
        console.warn('[game] dockTo failed', e);
      }
    }
    this.dockedAt = d.id;
    this.dockedSince = this.ctx.time.real;
    this.save.dock = d.id;
    if (announce) {
      this.ctx.events.emit('boat:docked', { dockId: d.id });
      this.play('dock');
    }
  }

  private nearestDock() {
    const b = this.ctx.boat;
    if (!b) return null;
    let best: Dock | null = null, bd = Infinity;
    for (const d of DOCKS) {
      const dd = Math.hypot(b.position.x - d.moorX, b.position.z - d.moorZ);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best && bd <= DOCK_RANGE ? { dock: best, dist: bd } : null;
  }

  private boatSpeed() {
    const b = this.ctx.boat;
    if (!b) return 0;
    return Math.max(Math.abs(b.speed || 0), Math.hypot(b.velocity?.x || 0, b.velocity?.z || 0));
  }

  private heading() {
    const b = this.ctx.boat;
    if (!b) return 0;
    const f = _fwd.set(0, 0, -1).applyQuaternion(b.quaternion);
    return forwardToHeading(f.x, f.z);
  }

  private interact() {
    const ctx = this.ctx;
    if (this.phase !== 'playing' || ctx.paused || !ctx.input.gameplayEnabled || !ctx.boat) return;
    if (this.dockedAt) return this.castOff();
    const near = this.nearestDock();
    if (!near || this.boatSpeed() > DOCK_MAX_SPEED) return;
    // moor in whichever direction the boat already points
    const h = this.heading();
    const diff = Math.abs(((h - near.dock.headingDeg + 540) % 360) - 180);
    const heading = diff <= 90 ? near.dock.headingDeg : (near.dock.headingDeg + 180) % 360;
    this.moor(near.dock, heading, true);
    this.onDocked(near.dock.id);
  }

  private castOff() {
    const id = this.dockedAt;
    try {
      this.ctx.boat?.undock();
    } catch (e) {
      console.warn('[game] undock failed', e);
    }
    this.dockedAt = null;
    this.ctx.events.emit('boat:undocked', { dockId: id });
    this.play('undock');
    const intro = byId.get('cast-off')!;
    if (this.status(intro) === 'available') {
      this.activate(intro);
      this.hint = { keys: [{ keys: ['W'], label: 'Throttle' }, { keys: ['S'], label: 'Reverse' }, { keys: ['A', 'D'], label: 'Steer' }], until: this.ctx.time.real + 30 };
    }
    this.persist();
  }

  private onDocked(dockId: string) {
    // finish the landing lesson and unload deliveries for this landing, announced together
    const done: ObjectiveDef[] = [];
    const lines: string[] = [];
    for (const o of OBJECTIVES) if (o.kind === 'dock' && o.dock === dockId && this.open(o)) { lines.push(this.complete(o, true)); done.push(o); }
    const carrying = this.save.cargo ? byId.get(this.save.cargo) : null;
    if (carrying && carrying.to === dockId) {
      this.save.cargo = null;
      this.cargo.set(null);
      lines.unshift(`${carrying.cargo ?? 'Cargo'} delivered.`);
      lines.push(this.complete(carrying, true));
      done.push(carrying);
    }
    if (done.length) {
      const lesson = done.some((o) => o.id === 'temple-steps');
      const detail = [...lines.filter(Boolean), lesson ? 'Everything from here is optional.' : ''].filter(Boolean).join(' ');
      if (lesson) {
        this.toast({ tone: 'complete', eyebrow: 'Lessons complete', title: 'The river is yours', detail });
        this.hint = { keys: [{ keys: ['M'], label: 'Open the river map' }], until: this.ctx.time.real + 14 };
      } else {
        this.toast({ tone: 'complete', eyebrow: 'Delivered', title: done[done.length - 1].title, detail: lines.filter((l) => !/delivered/.test(l)).join(' ') || undefined });
      }
      this.play('complete');
      this.finale();
    }
    this.evaluate();
    this.persist();
  }

  // ---------------------------------------------------------------- per frame

  private update(ctx: GameContext) {
    this.lanterns.update(ctx.time.render, ctx.time.frameDt);
    this.cargo.update();
    const b = ctx.boat;
    if (!b) return this.publish();
    const n = nearestRiver(b.position.x, b.position.z);
    const cur: RiverPos = { x: b.position.x, z: b.position.z, s: n.s, lateral: n.lateral, width: n.width };
    // the physics released the boat on its own (reset, unstuck): treat it as cast off
    if (this.dockedAt && b.docked === false && ctx.time.real - this.dockedSince > 3) {
      const id = this.dockedAt;
      this.dockedAt = null;
      ctx.events.emit('boat:undocked', { dockId: id });
    }
    if (this.phase === 'playing' && !ctx.paused && this.prev) {
      const jump = Math.hypot(cur.x - this.prev.x, cur.z - this.prev.z);
      if (jump < 30) {
        this.passBridges(this.prev, cur);
        this.progressGates(this.prev, cur);
      }
      this.discover(cur);
    }
    this.prev = cur;
    this.publish();
  }

  /** passing under a bridge: crossing its along-river position inside the channel */
  private passBridges(a: RiverPos, c: RiverPos) {
    for (const br of BRIDGES) {
      const crossed = (a.s < br.s) !== (c.s < br.s) && Math.abs(c.lateral) < c.width / 2 + 3;
      if (!crossed) continue;
      const upstream = c.s > a.s;
      this.markDiscovered(br.id);
      for (const o of OBJECTIVES) {
        if (o.kind === 'passage' && o.bridge === br.id && upstream && this.open(o) && !this.dockedAt) this.complete(o);
      }
    }
  }

  private progressGates(a: RiverPos, c: RiverPos) {
    for (const o of OBJECTIVES) {
      if (o.kind !== 'gates' || !this.open(o) || this.dockedAt) continue;
      const gates = o.route === 'lanterns' ? this.lanternRoute : [];
      const step = this.save.objectives[o.id]?.step ?? 0;
      const g = gates[step];
      if (!g || !crossed(a, c, g)) continue;
      this.activate(o);
      this.entry(o).step = step + 1;
      this.save.focus = o.id;
      this.play('gate');
      if (step + 1 >= gates.length) this.complete(o);
      else this.persist();
    }
  }

  private markDiscovered(id: string) {
    if (this.save.discovered.includes(id)) return;
    const p = POIS.find((x) => x.id === id);
    if (!p) return;
    this.save.discovered.push(id);
    this.ctx.events.emit('discovery', { id: p.id, name: p.name });
    const bridge = p.kind === 'bridge';
    const water = bridge || p.kind === 'waterfall' || p.kind === 'falls' || p.kind === 'gorge' || p.kind === 'torii' || p.kind === 'weir';
    const list = bridge ? BRIDGE_POIS : LANDMARK_POIS;
    const found = list.filter((x) => this.save.discovered.includes(x.id)).length;
    this.toast({ tone: 'discovery', eyebrow: bridge ? 'Passed under' : 'Discovered', title: p.name, italic: water && !bridge, detail: `${found} of ${list.length} ${bridge ? 'bridges' : 'landmarks'}. Added to your map.` });
    this.play('discovery');
    this.evaluate();
    this.persist();
  }

  private discover(c: RiverPos) {
    for (const p of LANDMARK_POIS) {
      if (this.save.discovered.includes(p.id)) continue;
      const r = this.reach.get(`poi:${p.id}`);
      const radius = Math.max(p.radius, r ? r.gap + 12 : 0);
      if (Math.hypot(c.x - p.x, c.z - p.z) <= radius) this.markDiscovered(p.id);
    }
    // a bridge also counts when the boat drifts right beneath it without a clean crossing
    for (const p of BRIDGE_POIS) if (!this.save.discovered.includes(p.id) && Math.hypot(c.x - p.x, c.z - p.z) < 8) this.markDiscovered(p.id);
  }

  // ---------------------------------------------------------------- service

  private tracked(): ObjectiveDef | null {
    for (const o of OBJECTIVES) if (o.intro && this.status(o) !== 'done') return o;
    if (this.save.cargo && this.open(byId.get(this.save.cargo))) return byId.get(this.save.cargo)!;
    if (this.save.focus && this.open(byId.get(this.save.focus))) return byId.get(this.save.focus)!;
    for (const id of SUGGESTION_ORDER) if (this.status(byId.get(id)!) === 'active') return byId.get(id)!;
    for (const id of SUGGESTION_ORDER) if (this.open(byId.get(id))) return byId.get(id)!;
    return null;
  }

  private progress(o: ObjectiveDef): { done: number; total: number } | null {
    if (o.kind === 'gates') {
      const n = this.lanternRoute.length;
      return { done: this.status(o) === 'done' ? n : this.save.objectives[o.id]?.step ?? 0, total: n };
    }
    if (o.kind === 'discover') {
      const list = o.group === 'bridges' ? BRIDGE_POIS : LANDMARK_POIS;
      return { done: list.filter((p) => this.save.discovered.includes(p.id)).length, total: list.length };
    }
    return null;
  }

  private line(o: ObjectiveDef): string {
    const st = this.status(o);
    if (st === 'done') return 'Complete.';
    switch (o.kind) {
      case 'passage':
        return this.dockedAt ? 'Press E to cast off from the village landing.' : `Head upstream and pass under the ${bridgeById.get(o.bridge!)?.name ?? 'bridge'}.`;
      case 'dock':
        return `Come alongside ${dockById.get(o.dock!)?.name} below ${speedWords(this.ctx, DOCK_MAX_SPEED)} and press E.`;
      case 'delivery': {
        const from = dockById.get(o.from!), to = dockById.get(o.to!);
        const what = (o.cargo ?? 'cargo').toLowerCase();
        if (this.save.cargo === o.id) return `Deliver the ${what} to ${to?.name}.`;
        if (this.save.cargo) return `Collect the ${what} at ${from?.name} once the boat is unloaded.`;
        return `Collect the ${what} at ${from?.name}.`;
      }
      case 'gates':
        return (this.save.objectives[o.id]?.step ?? 0) === 0 ? 'Find the first lanterns floating on the lake.' : 'Steer between the floating lanterns.';
      case 'discover':
        return o.group === 'bridges' ? 'Pass beneath every bridge on the river.' : 'Find the valley’s shrine, falls and other landmarks.';
    }
  }

  private target(o: ObjectiveDef | null): TargetView | null {
    const b = this.ctx.boat;
    if (!o || !b) return null;
    const dockTarget = (id?: string): TargetView | null => {
      const d = dockById.get(id ?? '');
      return d ? { x: d.moorX, z: d.moorZ, y: d.deckY + 1.4, label: d.name, kind: 'dock' } : null;
    };
    const nearest = (list: typeof POIS, kind: TargetView['kind'], label: (p: (typeof POIS)[number]) => string) => {
      let best: TargetView | null = null, bd = Infinity;
      for (const p of list) {
        if (this.save.discovered.includes(p.id)) continue;
        const r = this.reach.get(`${p.kind === 'bridge' ? 'bridge' : 'poi'}:${p.id}`);
        const x = r?.x ?? p.x, z = r?.z ?? p.z;
        const d = Math.hypot(x - b.position.x, z - b.position.z);
        if (d < bd) { bd = d; best = { x, z, y: kind === 'bridge' ? 3 : 2.5, label: label(p), kind }; }
      }
      return best;
    };
    switch (o.kind) {
      case 'passage': {
        if (this.dockedAt) return null;
        const br = bridgeById.get(o.bridge!);
        if (!br) return null;
        const f = riverFrame(br.s);
        return { x: f.x, z: f.z, y: Math.min(br.clearance, 3.2), label: br.name, kind: 'bridge' };
      }
      case 'dock':
        return this.dockedAt === o.dock ? null : dockTarget(o.dock);
      case 'delivery':
        return dockTarget(this.save.cargo === o.id ? o.to : o.from);
      case 'gates': {
        const g = this.lanternRoute[this.save.objectives[o.id]?.step ?? 0];
        return g ? { x: g.x, z: g.z, y: 1, label: 'Floating lanterns', kind: 'gate' } : null;
      }
      case 'discover':
        return o.group === 'bridges' ? nearest(BRIDGE_POIS, 'bridge', (p) => p.name) : nearest(LANDMARK_POIS, 'poi', () => 'Undiscovered');
    }
  }

  private view(o: ObjectiveDef): ObjectiveView {
    const st = this.status(o);
    return {
      id: o.id, kind: o.kind, label: o.label, title: o.title, summary: o.summary, status: st, intro: !!o.intro,
      progress: this.progress(o),
      line: this.line(o),
      lockedBy: st === 'locked' ? (o.requires ?? []).filter((r) => this.status(byId.get(r)!) !== 'done').map((r) => byId.get(r)!.title).join(', ') : null,
      reward: null,
    };
  }

  private prompt(): PromptView | null {
    if (this.phase !== 'playing' || !this.ctx.boat) return null;
    if (this.dockedAt) return { key: 'E', text: 'Cast off', tone: 'action' };
    const near = this.nearestDock();
    if (!near) return null;
    if (this.boatSpeed() <= DOCK_MAX_SPEED) return { key: 'E', text: `Dock at ${near.dock.name}`, tone: 'action' };
    // only coach the speed when the boat is closing on the berth, not while leaving it
    const b = this.ctx.boat!;
    const closing = (near.dock.moorX - b.position.x) * (b.velocity?.x ?? 0) + (near.dock.moorZ - b.position.z) * (b.velocity?.z ?? 0) > 0;
    return closing ? { text: `Slow below ${speedWords(this.ctx, DOCK_MAX_SPEED)} to dock`, tone: 'hint' } : null;
  }

  private hints(): HintKey[] | null {
    const now = this.ctx.time.real;
    if (this.phase !== 'playing') return null;
    if (this.hint && now < this.hint.until) return this.hint.keys;
    const lesson = byId.get('temple-steps')!;
    const b = this.ctx.boat;
    if (b && this.open(lesson) && !this.dockedAt) {
      const d = dockById.get(lesson.dock!)!;
      const dist = Math.hypot(b.position.x - d.moorX, b.position.z - d.moorZ);
      if (dist < 70 && dist > DOCK_RANGE) return [{ keys: ['S'], label: `Ease off and come in below ${speedWords(this.ctx, DOCK_MAX_SPEED)}` }];
    }
    return null;
  }

  publish() {
    const s = this.service;
    const tracked = this.tracked();
    s.phase = this.phase;
    s.hasSave = this.hadSave;
    s.objectives = OBJECTIVES.map((o) => this.view(o));
    s.tracked = tracked ? s.objectives.find((v) => v.id === tracked.id) ?? null : null;
    s.target = this.phase === 'playing' ? this.target(tracked) : null;
    s.prompt = this.prompt();
    s.hints = s.prompt ? null : this.hints();
    const c = this.save.cargo ? byId.get(this.save.cargo) : null;
    s.cargo = c ? { label: c.cargo ?? 'Cargo', to: dockById.get(c.to!)?.name ?? '' } : null;
    s.dockedAt = this.dockedAt;
    s.pois = POIS.map((p): PoiView => ({ id: p.id, name: p.name, kind: p.kind, x: p.x, z: p.z, discovered: this.save.discovered.includes(p.id) }));
    const lo = byId.get('lanterns')!;
    const done = this.status(lo) === 'done';
    s.routes = [{ id: 'lanterns', kind: 'lanterns', name: 'Lantern run', gates: this.lanternRoute, next: done ? this.lanternRoute.length : this.save.objectives[lo.id]?.step ?? 0 } satisfies RouteView];
    s.paints = this.paints.map((p): PaintView => {
      const unlocked = this.isUnlocked(p.id);
      return {
        id: p.id, name: p.name, swatch: p.swatch, trim: p.trim, unlocked,
        unlockText: null,
      };
    });
    s.paint = this.save.paint && this.isUnlocked(this.save.paint) ? this.save.paint : this.rewards.base;
    s.allDone = OBJECTIVES.every((o) => this.status(o) === 'done');
  }

  // ---------------------------------------------------------------- actions

  start() {
    if (this.phase === 'playing') return;
    this.phase = 'playing';
    this.refreshPaints();
    this.applyPaint();
    // the first cargo is waiting at the village landing
    this.evaluate();
    this.publish();
  }

  track(id: string) {
    const o = byId.get(id);
    if (!o || !this.open(o)) return;
    this.save.focus = id;
    this.persist();
    this.publish();
  }

  selectPaint(id: string) {
    if (!this.paints.some((p) => p.id === id) || !this.isUnlocked(id)) return false;
    this.save.paint = id;
    this.applyPaint();
    this.persist();
    this.publish();
    return true;
  }

  refreshPaints() {
    const list = paintList(this.ctx);
    if (list.map((p) => p.id).join() === this.paints.map((p) => p.id).join()) return;
    this.paints = list;
    this.rewards = assignRewards(OBJECTIVES, list);
    this.grantMissedRewards();
    this.publish();
  }

  newGame() {
    clearSave();
    this.save = emptySave();
    this.hadSave = false;
    this.cargo.set(null);
    this.hint = null;
    const home = dockById.get('village') ?? DOCKS[0];
    const b = this.ctx.boat;
    try {
      b?.undock();
      b?.teleport(home.moorX, home.moorZ, home.headingDeg);
    } catch {}
    this.moor(home, home.headingDeg, false);
    try {
      b?.setPaint(this.rewards.base);
    } catch {}
    this.prev = null;
    this.evaluate();
    this.persist();
    this.publish();
  }
}

const _fwd = new Vector3();

/** did the boat cross a gate line between its lanterns this frame (either direction) */
function crossed(a: { x: number; z: number }, c: { x: number; z: number }, g: GatePoint) {
  const s0 = (a.x - g.x) * g.dx + (a.z - g.z) * g.dz;
  const s1 = (c.x - g.x) * g.dx + (c.z - g.z) * g.dz;
  if ((s0 < 0) === (s1 < 0)) return false;
  const t = s0 / (s0 - s1);
  const ix = a.x + (c.x - a.x) * t, iz = a.z + (c.z - a.z) * t;
  const lateral = Math.abs((ix - g.x) * -g.dz + (iz - g.z) * g.dx);
  return lateral <= g.half + 1;
}
