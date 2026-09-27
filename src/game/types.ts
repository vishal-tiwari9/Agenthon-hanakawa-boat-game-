// shared shapes between gameplay (src/game) and the interface (src/ui). ctx.services.game is a GameService.

export type ObjectiveKind = 'passage' | 'gates' | 'dock' | 'delivery' | 'discover';
export type CargoKind = 'incense' | 'tea' | 'rice';
export type ObjectiveStatus = 'locked' | 'available' | 'active' | 'done';

export interface ObjectiveDef {
  id: string;
  kind: ObjectiveKind;
  /** eyebrow label: lesson, delivery, scenic route, discovery */
  label: string;
  /** short title, set in the serif */
  title: string;
  /** one line for the log */
  summary: string;
  requires?: string[];
  /** paint unlocked on completion: an exact id, or '@' + a preference pattern (e.g. '@vermilion|red') */
  reward?: string;
  intro?: boolean;
  /** passage: bridge id to pass under, heading upstream */
  bridge?: string;
  /** gates: route id (the lantern run) */
  route?: string;
  /** dock lesson: dock id */
  dock?: string;
  /** delivery: origin and destination dock ids, cargo description and model */
  from?: string;
  to?: string;
  cargo?: string;
  cargoKind?: CargoKind;
  /** discover: which places count ('bridges' or 'landmarks') */
  group?: 'bridges' | 'landmarks';
}

export interface ObjectiveView {
  id: string;
  kind: ObjectiveKind;
  label: string;
  title: string;
  summary: string;
  status: ObjectiveStatus;
  intro: boolean;
  /** e.g. gates 2 of 5 */
  progress: { done: number; total: number } | null;
  /** current instruction for the hud */
  line: string;
  /** name of the objective(s) that unlock this one when locked */
  lockedBy: string | null;
  reward: { id: string; name: string } | null;
}

export interface TargetView {
  x: number;
  z: number;
  /** meters above sea level to aim the screen marker at */
  y: number;
  label: string;
  kind: 'gate' | 'dock' | 'bridge' | 'poi';
}

export interface PromptView {
  /** keycap, e.g. 'E'; absent for pure hints */
  key?: string;
  text: string;
  tone: 'action' | 'hint';
}

export interface HintKey {
  keys: string[];
  label: string;
}

export interface PaintView {
  id: string;
  name: string;
  swatch: string;
  trim: string;
  unlocked: boolean;
  /** how to unlock, when locked */
  unlockText: string | null;
}

export interface GatePoint {
  x: number;
  z: number;
  /** unit crossing direction (route order) */
  dx: number;
  dz: number;
  /** half the gate width */
  half: number;
  /** along-river position */
  s?: number;
}

export interface RouteView {
  id: string;
  kind: 'lanterns';
  name: string;
  gates: GatePoint[];
  /** index of the next gate */
  next: number;
}

export interface PoiView {
  id: string;
  name: string;
  kind: string;
  x: number;
  z: number;
  discovered: boolean;
}

export interface ToastView {
  tone: 'complete' | 'discovery' | 'cargo' | 'info';
  eyebrow: string;
  title: string;
  detail?: string;
  /** set the title in italic (water features on charts are italic) */
  italic?: boolean;
}

export interface GameService {
  phase: 'title' | 'playing';
  hasSave: boolean;
  objectives: ObjectiveView[];
  tracked: ObjectiveView | null;
  target: TargetView | null;
  prompt: PromptView | null;
  hints: HintKey[] | null;
  cargo: { label: string; to: string } | null;
  dockedAt: string | null;
  pois: PoiView[];
  routes: RouteView[];
  paints: PaintView[];
  paint: string;
  allDone: boolean;
  start(): void;
  track(objectiveId: string): void;
  selectPaint(id: string): boolean;
  newGame(): void;
  refreshPaints(): void;
}
