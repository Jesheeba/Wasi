// Final mix: VO (each line at its scheduled start) + music sidechain-ducked under the
// voice + sound effects, then two-pass loudnorm to -14 LUFS / -1 dBTP (streaming spec).
// Works without VO too (preview mix), so the picture can be reviewed before the voice exists.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const A = path.join(ROOT, 'audio');
const T = require(path.join(ROOT, 'timing.json'));
const DUR = T.FILM_DURATION;
const run = (c) => execSync(c, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

const vo = T.estimated ? [] : T.schedule.filter((s) => fs.existsSync(path.join(A, `${s.id}.wav`)));
const inputs = [`-i "${path.join(A, 'music.wav')}"`, `-i "${path.join(A, 'sfx_track.wav')}"`];
const f = ['[0:a]volume=0.62[mus]', '[1:a]volume=0.85[sfx]'];
let mixIn;
if (vo.length) {
  vo.forEach((s, i) => {
    inputs.push(`-i "${path.join(A, s.id + '.wav')}"`);
    const ms = Math.round(s.start * 1000);
    f.push(`[${i + 2}:a]adelay=${ms}:all=1[v${i}]`);
  });
  f.push(`${vo.map((_, i) => `[v${i}]`).join('')}amix=inputs=${vo.length}:normalize=0,aformat=channel_layouts=stereo,asplit=2[vo][key]`);
  f.push('[mus][key]sidechaincompress=threshold=0.015:ratio=7:attack=25:release=450[duck]');
  f.push(`[duck][sfx][vo]amix=inputs=3:normalize=0,atrim=0:${DUR}[mix]`);
  mixIn = 'mix';
} else {
  f.push(`[mus][sfx]amix=inputs=2:normalize=0,atrim=0:${DUR}[mix]`);
  mixIn = 'mix';
  console.log('No measured VO yet: building a music + sfx preview mix.');
}
const pre = path.join(A, '_premix.wav');
run(`ffmpeg -y -hide_banner -loglevel error ${inputs.join(' ')} -filter_complex "${f.join(';')}" -map "[${mixIn}]" -ar 48000 -ac 2 "${pre}"`);

const m = JSON.parse(run(`ffmpeg -hide_banner -i "${pre}" -af loudnorm=I=-14:TP=-1:LRA=11:print_format=json -f null - 2>&1`).match(/\{[\s\S]*\}/)[0]);
const out = path.join(A, 'master.wav');
run(`ffmpeg -y -hide_banner -loglevel error -i "${pre}" -af "loudnorm=I=-14:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true" -ar 48000 -ac 2 "${out}"`);
fs.unlinkSync(pre);
console.log(`master.wav written (input ${m.input_i} LUFS -> -14 LUFS), VO lines mixed: ${vo.length}`);
