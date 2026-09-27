// download the recorded (public domain / cc0) sounds used by src/audio, trim/clean them with ffmpeg
// and record provenance. everything else in the soundscape is synthesized at runtime.
// usage: node tools/audio/fetch-sounds.mjs [--keep]   (needs ffmpeg with libmp3lame)
// sources were checked on wikimedia commons (license template on the file page, direct upload url
// from the imageinfo api). mp3 so both chrome and safari can decodeAudioData it.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, stat, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const outRoot = join(root, 'public/assets/audio');
const UA = 'luma-coast-dev/0.1 (local game asset provenance)';

const BIRD = 'highpass=f=700,highpass=f=700,afftdn=nr=12:nf=-40,lowpass=f=5200';
const STREAM = 'highpass=f=80,highpass=f=80,lowpass=f=12000';

const SOURCES = [
  {
    id: 'uguisu',
    name: 'Japanese bush warbler (uguisu) songs',
    source: 'https://commons.wikimedia.org/wiki/File:SND_4458a.ogg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/1/12/SND_4458a.ogg',
    license: 'Public domain (PD-self)',
    authors: ['Fg2'],
    note: 'Horornis (Cettia) diphone, recorded outside Kashihara Shrine at the foot of Mount Unebi, Nara, Japan. Six "hoo-hokekyo" phrases cut out.',
    // [file, start s, duration s]
    clips: [
      ['uguisu-a.mp3', 5.9, 1.7],
      ['uguisu-b.mp3', 16.35, 1.75],
      ['uguisu-c.mp3', 29.4, 1.8],
      ['uguisu-d.mp3', 43.35, 1.55],
      ['uguisu-e.mp3', 49.65, 1.65],
      ['uguisu-f.mp3', 57.35, 1.75],
    ],
    filter: BIRD,
    encode: ['-ar', '22050', '-b:a', '64k'],
  },
  {
    id: 'tit',
    name: 'Great tit song',
    source: 'https://commons.wikimedia.org/wiki/File:Parus_major.ogg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/d/df/Parus_major.ogg',
    license: 'Public domain (PD-self)',
    authors: ['Oona Räisänen (Mysid)'],
    note: 'Parus major singing in a birch, southern Finland, 2007 (stands in for the very similar Japanese tit, Parus minor).',
    clips: [['tit-a.mp3', 0.45, 1.9]],
    filter: 'highpass=f=1500,highpass=f=1500,afftdn=nr=10:nf=-40,lowpass=f=9000',
    encode: ['-ar', '22050', '-b:a', '64k'],
  },
  {
    id: 'wren',
    name: 'Wren song',
    source: 'https://commons.wikimedia.org/wiki/File:Troglodytes_troglodytes.ogg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/0/01/Troglodytes_troglodytes.ogg',
    license: 'Public domain (PD-self)',
    authors: ['Sogning'],
    note: 'Troglodytes troglodytes, Norway, 2006 (stands in for the Japanese wren, whose song is similar).',
    clips: [['wren-a.mp3', 0.9, 5.2]],
    filter: 'highpass=f=2500,highpass=f=2500,afftdn=nr=15:nf=-38,lowpass=f=9500',
    encode: ['-ar', '22050', '-b:a', '64k'],
  },
  {
    id: 'river-rinnsal',
    name: 'Brook trickling by a meadow (Molln)',
    source: 'https://commons.wikimedia.org/wiki/File:2024-07-26_Molln_(Ober%C3%B6sterreich)_Rinnsal_pl%C3%A4tschert_bei_der_Wiese_im_Wasserschutzgebiet_Br%C3%A4ugrabenstra%C3%9Fe.wav',
    url: 'https://upload.wikimedia.org/wikipedia/commons/7/7a/2024-07-26_Molln_%28Ober%C3%B6sterreich%29_Rinnsal_pl%C3%A4tschert_bei_der_Wiese_im_Wasserschutzgebiet_Br%C3%A4ugrabenstra%C3%9Fe.wav',
    license: 'CC0 1.0 (self)',
    authors: ['DrTrumpet'],
    note: 'Mollner Bach, Molln, Upper Austria, 2024. Neumann TLM 102 + Zoom H6. Calm river bed loop.',
    clips: [['river-calm.mp3', 0.5, 27.5]],
    filter: STREAM,
    encode: ['-ar', '44100', '-b:a', '96k'],
    loudness: -22,
  },
  {
    id: 'river-bach',
    name: 'Stream babbling (Molln, Krumme Steyerling)',
    source: 'https://commons.wikimedia.org/wiki/File:2024-07-26_Molln_(Ober%C3%B6sterreich)_Bachlauf_pl%C3%A4tschert_(Krumme_Steyerling_bei_Piesslingerstra%C3%9Fe).wav',
    url: 'https://upload.wikimedia.org/wikipedia/commons/2/29/2024-07-26_Molln_%28Ober%C3%B6sterreich%29_Bachlauf_pl%C3%A4tschert_%28Krumme_Steyerling_bei_Piesslingerstra%C3%9Fe%29.wav',
    license: 'CC0 1.0 (self)',
    authors: ['DrTrumpet'],
    note: 'Krumme Steyerling near Piesslingerstrasse, Molln, Upper Austria, 2024. Neumann TLM 102 + Zoom H6. Faster-current babble loop.',
    clips: [['river-babble.mp3', 0.3, 26]],
    filter: STREAM,
    encode: ['-ar', '44100', '-b:a', '96k'],
    loudness: -22,
  },
  {
    id: 'river-stony',
    name: 'Shallow small river with stony riverbed',
    source: 'https://commons.wikimedia.org/wiki/File:Shallow_small_river_with_stony_riverbed.ogg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/2/21/Shallow_small_river_with_stony_riverbed.ogg',
    license: 'Public domain (PD-author, via PDSounds.org)',
    authors: ['stephan'],
    note: 'The Wupper at Leichlingen, Germany, recorded from a bridge, 2007. PDSounds record 99. Rocky gorge rapids loop.',
    clips: [['river-rapids.mp3', 0.2, 17.5]],
    filter: STREAM,
    encode: ['-ar', '44100', '-b:a', '96k'],
    loudness: -22,
  },
  {
    id: 'bank-trickle',
    name: 'Water trickle in a wooded burn',
    source: 'https://commons.wikimedia.org/wiki/File:363120_fractalstudios_water-trickle.wav',
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/a6/363120_fractalstudios_water-trickle.wav',
    license: 'CC0 1.0 (via freesound.org/people/FractalStudios/sounds/363120)',
    authors: ['FractalStudios'],
    note: 'A small burn trickling through a wooded area, Zoom H1, 2016. Bank lapping/trickle loop.',
    clips: [['bank-trickle.mp3', 4, 28]],
    filter: STREAM,
    encode: ['-ar', '44100', '-b:a', '96k'],
    loudness: -22,
  },
];

const keep = process.argv.includes('--keep');
const tmp = await mkdtemp(join(tmpdir(), 'luma-audio-'));

async function download(url, dest) {
  if (existsSync(dest)) return;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      await writeFile(dest, Buffer.from(await r.arrayBuffer()));
      return;
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

function ff(args) {
  return execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** integrated loudness and true peak of a filtered section (loudnorm analysis pass) */
function analyse(src, start, dur, filter) {
  // loudnorm prints its json report on stderr
  const res = execFileSync('sh', ['-c', `ffmpeg -hide_banner -ss ${start} -t ${dur} -i "${src}" -ac 1 -af "${filter},loudnorm=print_format=json" -f null - 2>&1`], { encoding: 'utf8' });
  const j = JSON.parse(res.slice(res.lastIndexOf('{'), res.lastIndexOf('}') + 1));
  return { i: Number(j.input_i), tp: Number(j.input_tp) };
}

for (const s of SOURCES) {
  const dir = join(outRoot, s.id);
  await mkdir(dir, { recursive: true });
  const src = join(tmp, s.id + (s.url.endsWith('.wav') ? '.wav' : '.ogg'));
  await download(s.url, src);
  const files = [];
  for (const [file, start, dur] of s.clips) {
    const out = join(dir, file);
    const fadeOut = Math.min(0.12, dur * 0.1);
    // linear gain only, so swells and calls keep their natural dynamics
    const m = analyse(src, start, dur, s.filter);
    const gain = s.loudness ? Math.min(s.loudness - m.i, -1.5 - m.tp) : -2 - m.tp;
    const af = `${s.filter},volume=${gain.toFixed(2)}dB,afade=t=in:d=0.015,afade=t=out:st=${(dur - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`;
    ff(['-ss', String(start), '-t', String(dur), '-i', src, '-ac', '1', '-af', af, ...s.encode, '-c:a', 'libmp3lame', out]);
    const size = (await stat(out)).size;
    files.push({ file, url: s.url, from: `${start}s`, duration: `${dur}s`, size });
    console.log(`${s.id}/${file} ${(size / 1e3).toFixed(0)} KB`);
  }
  const prov = {
    id: s.id,
    name: s.name,
    type: 'audio',
    source: s.source,
    license: s.license,
    authors: s.authors,
    note: s.note,
    processing: `ffmpeg: trim, mono, ${s.filter}, linear gain to ${s.loudness ? `${s.loudness} LUFS (true peak <= -1.5 dBTP)` : 'peak -2 dBFS'}, short fades; mp3 via libmp3lame`,
    downloaded: new Date().toISOString(),
    files,
  };
  await writeFile(join(dir, 'provenance.json'), JSON.stringify(prov, null, 2));
}

if (!keep) await rm(tmp, { recursive: true, force: true });
else console.log('kept sources in', tmp);
