// the few recorded sounds (public domain / cc0, see public/assets/audio/*/provenance.json). files
// are fetched once the valley is revealed (no AudioContext needed) and decoded once audio starts. every layer that
// uses a recording also works without it, so a failed download only removes that texture.
import { makeLoop } from './dsp';

const BASE = import.meta.env.BASE_URL + 'assets/audio/';

export const BIRD_FILES = {
  uguisu: ['uguisu/uguisu-a.mp3', 'uguisu/uguisu-b.mp3', 'uguisu/uguisu-c.mp3', 'uguisu/uguisu-d.mp3', 'uguisu/uguisu-e.mp3', 'uguisu/uguisu-f.mp3'],
  tit: ['tit/tit-a.mp3'],
  wren: ['wren/wren-a.mp3'],
};
export type Songbird = keyof typeof BIRD_FILES;

const LOOPS = {
  calm: 'river-rinnsal/river-calm.mp3',
  babble: 'river-bach/river-babble.mp3',
  rapids: 'river-stony/river-rapids.mp3',
  trickle: 'bank-trickle/bank-trickle.mp3',
};
export type LoopName = keyof typeof LOOPS;

export class Samples {
  birds: Record<Songbird, AudioBuffer[]> = { uguisu: [], tit: [], wren: [] };
  loops: Partial<Record<LoopName, AudioBuffer>> = {};
  failed: string[] = [];
  ready = false;
  private raw = new Map<string, Promise<ArrayBuffer | null>>();
  private listeners: (() => void)[] = [];

  prefetch() {
    if (this.raw.size) return;
    for (const f of [...Object.values(BIRD_FILES).flat(), ...Object.values(LOOPS)]) {
      this.raw.set(
        f,
        fetch(BASE + f)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
          .catch(() => {
            this.failed.push(f);
            return null;
          }),
      );
    }
  }

  /** run `fn` once the samples are decoded (immediately if they already are) */
  onReady(fn: () => void) {
    if (this.ready) fn();
    else this.listeners.push(fn);
  }

  private async decode(ac: BaseAudioContext, f: string): Promise<AudioBuffer | null> {
    this.prefetch();
    const data = await this.raw.get(f);
    if (!data) return null;
    try {
      return await ac.decodeAudioData(data.slice(0));
    } catch {
      this.failed.push(f);
      return null;
    }
  }

  /** decode everything; missing files stay empty */
  async decodeAll(ac: BaseAudioContext) {
    const birds = await Promise.all(
      (Object.keys(BIRD_FILES) as Songbird[]).map(async (k) => [k, (await Promise.all(BIRD_FILES[k].map((f) => this.decode(ac, f)))).filter((b): b is AudioBuffer => !!b)] as const),
    );
    for (const [k, list] of birds) this.birds[k] = list;
    await Promise.all(
      (Object.keys(LOOPS) as LoopName[]).map(async (k) => {
        const b = await this.decode(ac, LOOPS[k]);
        if (b) this.loops[k] = makeLoop(ac, b, 2);
      }),
    );
    this.ready = true;
    for (const fn of this.listeners.splice(0)) fn();
  }
}
