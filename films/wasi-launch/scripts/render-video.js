// Encodes frames + master audio to H.264/AAC MP4, writes captions (.srt) and a poster.
// While the VO is still estimated the output is named *_PREVIEW_no-voice.mp4 so a
// placeholder cut can never be mistaken for the final.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'output');
const T = require(path.join(ROOT, 'timing.json'));
const LINES = require(path.join(ROOT, 'lines.json'));
fs.mkdirSync(OUT, { recursive: true });

const name = T.estimated ? 'wasi-launch-90s_PREVIEW_no-voice' : 'wasi-launch-90s';
const mp4 = path.join(OUT, name + '.mp4');
execSync(`ffmpeg -y -hide_banner -loglevel error -framerate 30 -i "${path.join(ROOT, 'frames', 'f_%05d.png')}" -i "${path.join(ROOT, 'audio', 'master.wav')}" ` +
  `-map 0:v -map 1:a -c:v libx264 -preset slow -crf 16 -profile:v high -pix_fmt yuv420p -r 30 ` +
  `-c:a aac -b:a 256k -ar 48000 -t ${T.FILM_DURATION} -movflags +faststart "${mp4}"`, { stdio: 'inherit', shell: true });

const fmt = (t) => { const ms = Math.round(t * 1000); const p = (n, l = 2) => String(n).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
const byId = Object.fromEntries(T.schedule.map((s) => [s.id, s]));
fs.writeFileSync(path.join(OUT, 'wasi-launch-90s.srt'), LINES.map((l, i) => `${i + 1}\n${fmt(byId[l.id].start)} --> ${fmt(byId[l.id].end)}\n${l.sub}\n`).join('\n'));

const posterAt = T.scenes.s10.end - 2.5;
execSync(`ffmpeg -y -hide_banner -loglevel error -ss ${posterAt} -i "${mp4}" -frames:v 1 -q:v 2 "${path.join(OUT, 'poster.jpg')}"`, { shell: true });
console.log('Wrote', mp4, '+ wasi-launch-90s.srt + poster.jpg');
