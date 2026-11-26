// ElevenLabs voice-over, one take per line, joined with previous_text/next_text
// so the read flows as one performance. Skips lines whose audio/<id>.wav exists
// (a rebuild spends no credits). Key: ELEVENLABS_API_KEY, else `eleven_labs`
// from server/.env. The key is never printed or written anywhere.
//   node scripts/generate-vo.js           generate missing lines
//   node scripts/generate-vo.js --check   verify the key and voice only (no credits)
//   node scripts/generate-vo.js --force   regenerate every line
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LINES = require(path.join(ROOT, 'lines.json'));
const AUDIO_DIR = path.join(ROOT, 'audio');
const VOICE_ID = 'J9gbaR3XWZq9razzBxca';
const MODEL_ID = 'eleven_multilingual_v2';
// Delivery speed (ElevenLabs allows 0.7-1.2). 1.0 is the voice's natural pace;
// build-timing.js reports if the read is too long for 90s.
const VO_SPEED = parseFloat(process.env.VO_SPEED || '1.0');

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  require(path.join(ROOT, '..', '..', 'server', 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '..', '..', 'server', '.env') });
  return (process.env.eleven_labs || '').trim();
}

const probe = (f) => parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}"`).toString());

async function check(key) {
  const res = await fetch(`https://api.elevenlabs.io/v1/voices/${VOICE_ID}`, { headers: { 'xi-api-key': key } });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return console.log(`Key OK. Voice: ${body.name} (${body.category})`);
  if (!/voices_read/.test(JSON.stringify(body))) throw new Error(`ElevenLabs ${res.status}: ${body.detail?.message || JSON.stringify(body)}`);
  // key is valid but TTS-only: prove it with a 3-character synthesis instead
  const t = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hi.', model_id: MODEL_ID }),
  });
  if (!t.ok) throw new Error(`ElevenLabs TTS ${t.status}: ${await t.text()}`);
  await t.arrayBuffer();
  console.log('Key OK (text-to-speech permission; voices_read not granted, not needed).');
}

async function tts(key, line, prev, next) {
  const body = {
    text: line.text,
    model_id: MODEL_ID,
    voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true, speed: VO_SPEED },
  };
  if (prev) body.previous_text = prev;
  if (next) body.next_text = next;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status} for ${line.id}: ${await res.text()}`);
  const mp3 = path.join(AUDIO_DIR, `${line.id}.mp3`);
  const wav = path.join(AUDIO_DIR, `${line.id}.wav`);
  fs.writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
  // trim leading/trailing silence so timing measures speech, not padding
  execSync(`ffmpeg -y -hide_banner -loglevel error -i "${mp3}" -af "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse" -ar 44100 -ac 1 "${wav}"`);
  fs.unlinkSync(mp3);
  return probe(wav);
}

async function main() {
  const key = apiKey();
  if (!key) { console.error('No ElevenLabs key found (ELEVENLABS_API_KEY or server/.env eleven_labs). No credits spent.'); process.exit(1); }
  await check(key);
  if (process.argv.includes('--check')) return;

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const force = process.argv.includes('--force');
  const durations = {};
  for (let i = 0; i < LINES.length; i++) {
    const line = LINES[i];
    const wav = path.join(AUDIO_DIR, `${line.id}.wav`);
    if (!force && fs.existsSync(wav)) { durations[line.id] = probe(wav); console.log(`${line.id}: exists (${durations[line.id].toFixed(2)}s)`); continue; }
    durations[line.id] = await tts(key, line, LINES[i - 1]?.text, LINES[i + 1]?.text);
    console.log(`${line.id}: ${durations[line.id].toFixed(2)}s  "${line.text.slice(0, 48)}..."`);
  }
  fs.writeFileSync(path.join(ROOT, 'vo-durations.json'), JSON.stringify(durations, null, 2));
  console.log('Wrote vo-durations.json');
}

main().catch((err) => { console.error('VO failed:', err.message); process.exit(1); });
