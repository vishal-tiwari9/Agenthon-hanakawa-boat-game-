// local save: progress, unlocks, selected paint, cargo and the last berth. settings live in core.

export interface ObjectiveSave {
  status: 'active' | 'done';
  /** gates: index of the next gate */
  step?: number;
}

export interface SaveData {
  v: 1;
  objectives: Record<string, ObjectiveSave>;
  discovered: string[];
  unlocked: string[];
  paint: string | null;
  /** dock id of the last berth, where the next session starts */
  dock: string | null;
  /** delivery objective id whose cargo is aboard */
  cargo: string | null;
  /** objective the player last worked on or set course for */
  focus: string | null;
  savedAt: number;
}

const KEY = 'hanakawa/save/v1';

export function emptySave(): SaveData {
  return { v: 1, objectives: {}, discovered: [], unlocked: [], paint: null, dock: null, cargo: null, focus: null, savedAt: 0 };
}

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || d.v !== 1 || typeof d.objectives !== 'object') return null;
    const base = emptySave();
    return {
      ...base,
      ...d,
      discovered: Array.isArray(d.discovered) ? d.discovered.filter((x: unknown) => typeof x === 'string') : [],
      unlocked: Array.isArray(d.unlocked) ? d.unlocked.filter((x: unknown) => typeof x === 'string') : [],
    };
  } catch {
    return null;
  }
}

export function writeSave(s: SaveData) {
  try {
    s.savedAt = Date.now();
    localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}
