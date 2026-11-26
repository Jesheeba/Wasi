// Score: one instrumental track from ElevenLabs Music (music_v1, composition plan),
// with its sections sized to the scenes in timing.json so the lift lands on
// "Meet Wasi" and the resolve lands on the end card. Cached by a hash of the plan:
// a rebuild with the same plan spends no credits. Key: ELEVENLABS_API_KEY, else
// `eleven_labs` from server/.env. The key is never printed or written anywhere.
// Output: audio/music.wav, 48 kHz stereo, exactly FILM_DURATION long.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const A = path.join(ROOT, 'audio');
const T = require(path.join(ROOT, 'timing.json'));
const S = T.scenes, DUR = T.FILM_DURATION;

function key() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  require(path.join(ROOT, '..', '..', 'server', 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '..', '..', 'server', '.env'), quiet: true });
  return (process.env.eleven_labs || '').trim();
}

const GLOBAL = ['instrumental', 'premium technology product launch film score', 'modern, optimistic, elegant, confident',
  'felt piano', 'warm analog synth pads', 'soft plucked synth arpeggio', 'tight soft kick and finger snaps', '104 bpm', 'clean wide mix'];
const NEG = ['vocals', 'singing', 'choir', 'spoken word', 'lyrics', 'heavy distortion', 'aggressive', 'dubstep', 'EDM drop', 'trap hi-hats', 'cinematic trailer braams'];
// [name, from, to, styles]
const PLAN = [
  ['Intro', 0, S.s02.start, ['solo felt piano motif', 'sparse', 'airy', 'curious anticipation', 'no drums']],
  ['Reveal', S.s02.start, S.s03.start, ['warm pad swells in', 'gentle lift', 'soft pulse begins', 'hopeful']],
  ['Theme A', S.s03.start, S.s05.start, ['steady soft beat', 'plucked arpeggio', 'piano melody', 'warm bass', 'light and friendly']],
  ['Theme B', S.s05.start, S.s07.start, ['fuller groove', 'arpeggio doubles', 'subtle claps', 'forward momentum', 'polished']],
  ['Theme C', S.s07.start, S.s09.start, ['groove continues', 'piano countermelody', 'bright and steady']],
  ['Build', S.s09.start, S.s10.start, ['rising build', 'snare roll that stays soft', 'brighter pads', 'anticipation']],
  ['Finale', S.s10.start, DUR, ['full warm resolve', 'piano and pads', 'drums settle out after the first bar', 'one long sustained final major chord held right to the end of the section', 'no early ending'], ['abrupt ending', 'early fade out', 'silence']],
];
const body = {
  model_id: 'music_v1',
  composition_plan: {
    positive_global_styles: GLOBAL,
    negative_global_styles: NEG,
    sections: PLAN.map(([n, a, b, st, neg]) => ({ section_name: n, positive_local_styles: st, negative_local_styles: neg || [], duration_ms: Math.round((b - a) * 1000), lines: [] })),
  },
};
const total = body.composition_plan.sections.reduce((s, x) => s + x.duration_ms, 0);
body.composition_plan.sections[PLAN.length - 1].duration_ms += Math.round(DUR * 1000) - total; // exact 90.000 s
for (const s of body.composition_plan.sections) if (s.duration_ms < 3000) throw new Error(`section ${s.section_name} is under 3 s`);

const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
const raw = path.join(A, `music_el_${hash}.mp3`);
const out = path.join(A, 'music.wav');

(async () => {
  if (!fs.existsSync(raw) || process.argv.includes('--force')) {
    const k = key();
    if (!k) { console.error('No ElevenLabs key found. No credits spent.'); process.exit(1); }
    console.log(`Composing ${PLAN.length} sections, ${DUR}s (ElevenLabs music_v1)...`);
    const r = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
      method: 'POST', headers: { 'xi-api-key': k, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) { console.error(`ElevenLabs music failed: HTTP ${r.status} ${(await r.text()).slice(0, 600)}`); process.exit(1); }
    fs.writeFileSync(raw, Buffer.from(await r.arrayBuffer()));
  } else console.log('Score cached for this plan; no credits spent.');
  // The model opens with ~2.3 s of silence, so the track starts LEAD s early: the piano now
  // enters just before the first word, and the final chord rings out right after the last one.
  const LEAD = 1.3;
  execSync(`ffmpeg -y -hide_banner -loglevel error -i "${raw}" -af "atrim=start=${LEAD},asetpts=PTS-STARTPTS,apad,atrim=0:${DUR},afade=t=out:st=${DUR - 1.2}:d=1.2" -ar 48000 -ac 2 "${out}"`, { shell: true });
  const d = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${raw}"`, { shell: true }).toString().trim();
  console.log(`music.wav written (source ${(+d).toFixed(2)} s -> ${DUR} s)`);
})().catch((e) => { console.error(e); process.exit(1); });
