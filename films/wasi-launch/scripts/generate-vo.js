// ElevenLabs voice-over as ONE continuous take of the whole script, so the read
// flows as a single performance (no per-line takes stitched together). Uses the
// /with-timestamps endpoint: every character comes back with its start/end time,
// which gives exact word timings for the picture and clean cut points between
// scenes (build-timing.js only ever cuts inside the natural pause between scenes;
// inside a scene the take is untouched).
// Skips the call when the cached take matches the current script + settings, so a
// rebuild spends no credits. Key: ELEVENLABS_API_KEY, else `eleven_labs` from
// server/.env. The key is never printed or written anywhere.
//   node scripts/generate-vo.js           generate if the script changed
//   node scripts/generate-vo.js --check   verify the key only (spends ~3 characters)
//   node scripts/generate-vo.js --force   regenerate
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LINES = require(path.join(ROOT, 'lines.json'));
const AUDIO_DIR = path.join(ROOT, 'audio');
const TAKE_WAV = path.join(AUDIO_DIR, 'vo_take.wav');
const TAKE_JSON = path.join(ROOT, 'vo-take.json');
const VOICE_ID = 'J9gbaR3XWZq9razzBxca';
const MODEL_ID = 'eleven_multilingual_v2';
// 0.7-1.2. Slightly above natural for a launch-film pace.
const VO_SPEED = parseFloat(process.env.VO_SPEED || '1.08');
const SETTINGS = { stability: 0.55, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true, speed: VO_SPEED };

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  require(path.join(ROOT, '..', '..', 'server', 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '..', '..', 'server', '.env'), quiet: true });
  return (process.env.eleven_labs || '').trim();
}

// Scenes are paragraphs; lines within a scene run on as sentences. Offsets let us
// find each line inside the alignment that comes back.
function buildScript() {
  let text = '';
  const ranges = {};
  let scene = null;
  LINES.forEach((l) => {
    if (text) text += l.scene === scene ? ' ' : '\n\n';
    scene = l.scene;
    ranges[l.id] = [text.length, text.length + l.text.length];
    text += l.text;
  });
  return { text, ranges };
}

async function check(key) {
  const t = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hi.', model_id: MODEL_ID }),
  });
  if (!t.ok) throw new Error(`ElevenLabs ${t.status}: ${(await t.text()).slice(0, 300)}`);
  await t.arrayBuffer();
  console.log('Key OK (text-to-speech).');
}

function wordsOf(al, a, b) {
  const words = [];
  let cur = null;
  for (let i = a; i < b; i++) {
    const ch = al.characters[i];
    if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null; } continue; }
    if (!cur) cur = { w: '', s: al.character_start_times_seconds[i] };
    cur.w += ch;
    cur.e = al.character_end_times_seconds[i];
  }
  if (cur) words.push(cur);
  return words.map((w) => ({ w: w.w, s: +w.s.toFixed(3), e: +w.e.toFixed(3) }));
}

async function main() {
  const { text, ranges } = buildScript();
  const hash = crypto.createHash('sha256').update(JSON.stringify({ text, SETTINGS, MODEL_ID, VOICE_ID })).digest('hex').slice(0, 16);
  const force = process.argv.includes('--force');
  if (!force && !process.argv.includes('--check') && fs.existsSync(TAKE_JSON) && fs.existsSync(TAKE_WAV) && require(TAKE_JSON).hash === hash) {
    console.log('VO take is current (script and settings unchanged). No credits spent.');
    return;
  }
  const key = apiKey();
  if (!key) { console.error('No ElevenLabs key found (ELEVENLABS_API_KEY or server/.env eleven_labs). No credits spent.'); process.exit(1); }
  if (process.argv.includes('--check')) return check(key);

  console.log(`Generating one continuous take: ${text.length} characters, speed ${VO_SPEED}`);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: SETTINGS }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const al = body.alignment;
  if (!al || al.characters.length !== text.length) throw new Error(`alignment length ${al && al.characters.length} != text length ${text.length}`);

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const mp3 = path.join(AUDIO_DIR, 'vo_take.mp3');
  fs.writeFileSync(mp3, Buffer.from(body.audio_base64, 'base64'));
  execSync(`ffmpeg -y -hide_banner -loglevel error -i "${mp3}" -ar 44100 -ac 1 "${TAKE_WAV}"`);
  fs.unlinkSync(mp3);
  const duration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${TAKE_WAV}"`).toString());

  const lines = {};
  LINES.forEach((l) => {
    const words = wordsOf(al, ranges[l.id][0], ranges[l.id][1]);
    lines[l.id] = { start: words[0].s, end: words[words.length - 1].e, words };
  });
  fs.writeFileSync(TAKE_JSON, JSON.stringify({ hash, duration: +duration.toFixed(3), speed: VO_SPEED, lines }, null, 1));
  const speech = LINES.reduce((a, l) => a + lines[l.id].end - lines[l.id].start, 0);
  console.log(`Take ${duration.toFixed(2)}s (speech ${speech.toFixed(2)}s), ${Object.keys(lines).length} lines aligned -> vo-take.json`);
}

main().catch((err) => { console.error('VO failed:', err.message); process.exit(1); });
