// Final mix. VO: the continuous ElevenLabs take, cut once per scene (in the natural
// pause between scenes, with tiny fades) and placed at that scene's start, so the
// read stays one unbroken performance. Music is a steady bed under the voice (no
// pumping sidechain): a fixed level with a light 2.8 kHz dip to keep words clear, lifted
// +6 dB only before the first line and after the last. Then two-pass loudnorm to
// -14 LUFS / -1 dBTP (streaming spec).
// Prints the music-vs-voice level gap so "music below the voice" is measured, not assumed.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const A = path.join(ROOT, 'audio');
const T = require(path.join(ROOT, 'timing.json'));
const DUR = T.FILM_DURATION;
const run = (c) => execSync(c, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).toString();
const lufsOf = (out) => parseFloat(out.match(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/)?.[1] ?? 'NaN');
// loudness only while the voice is speaking (lines from timing.json), so intro/outro music and
// ducking gates don't skew the voice-vs-music comparison
const SPEECH = T.schedule.map((s) => `between(t\\,${s.start}\\,${s.end})`).join('+');
const lufsSpeech = (f) => lufsOf(run(`ffmpeg -hide_banner -i "${f}" -af "aselect='${SPEECH}',asetpts=N/SR/TB,ebur128" -f null - 2>&1`));

const MUSIC_GAIN = parseFloat(process.env.MUSIC_GAIN || '0.125'), SFX_GAIN = 0.35;
const first = T.schedule[0].start - 0.1, last = T.schedule[T.schedule.length - 1].end + 0.15;
const lift = `volume='1+1*max(min(max((${first}-t)/0.6\,0)\,1)\,min(max((t-${last})/0.8\,0)\,1))':eval=frame`;
const take = path.join(A, 'vo_take.wav');
const hasVo = !T.estimated && fs.existsSync(take);
const inputs = [`-i "${path.join(A, 'music.wav')}"`, `-i "${path.join(A, 'sfx_track.wav')}"`];
const f = [
  `[0:a]volume=${MUSIC_GAIN},equalizer=f=2800:t=q:w=1.4:g=-3,${lift}[mus]`,
  `[1:a]volume=${SFX_GAIN}[sfx]`,
];
if (hasVo) {
  inputs.push(`-i "${take}"`);
  const scenes = Object.values(T.scenes);
  f.push(`[2:a]asplit=${scenes.length}${scenes.map((_, i) => `[t${i}]`).join('')}`);
  scenes.forEach((s, i) => {
    const d = s.seg.b - s.seg.a;
    f.push(`[t${i}]atrim=start=${s.seg.a}:end=${s.seg.b},asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st=${(d - 0.05).toFixed(3)}:d=0.05,adelay=${Math.round(s.seg.place * 1000)}:all=1[v${i}]`);
  });
  f.push(`${scenes.map((_, i) => `[v${i}]`).join('')}amix=inputs=${scenes.length}:normalize=0,highpass=f=70,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=160:makeup=2,equalizer=f=3200:t=q:w=1.2:g=1.5,aformat=channel_layouts=stereo,asplit=2[vo][vostem]`);
  f.push('[mus]asplit=2[duck1][musstem]');
  f.push(`[duck1][sfx][vo]amix=inputs=3:normalize=0,atrim=0:${DUR}[mix]`);
} else {
  f.push(`[mus][sfx]amix=inputs=2:normalize=0,atrim=0:${DUR}[mix]`);
  console.log('No VO take yet: building a music + sfx preview mix.');
}
const pre = path.join(A, '_premix.wav'), vs = path.join(A, '_vo_stem.wav'), ms = path.join(A, '_mus_stem.wav');
const maps = hasVo ? `-map "[mix]" -ar 48000 -ac 2 "${pre}" -map "[vostem]" "${vs}" -map "[musstem]" "${ms}"` : `-map "[mix]" -ar 48000 -ac 2 "${pre}"`;
run(`ffmpeg -y -hide_banner -loglevel error ${inputs.join(' ')} -filter_complex "${f.join(';')}" ${maps}`);
if (hasVo) {
  const v = lufsSpeech(vs), m = lufsSpeech(ms);
  console.log(`voice ${v.toFixed(1)} LUFS, music bed ${m.toFixed(1)} LUFS -> music sits ${(v - m).toFixed(1)} dB under the voice while it speaks`);
  fs.unlinkSync(vs); fs.unlinkSync(ms);
}
const m = JSON.parse(run(`ffmpeg -hide_banner -i "${pre}" -af loudnorm=I=-14:TP=-1:LRA=11:print_format=json -f null - 2>&1`).match(/\{[\s\S]*\}/)[0]);
const out = path.join(A, 'master.wav');
run(`ffmpeg -y -hide_banner -loglevel error -i "${pre}" -af "loudnorm=I=-14:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true" -ar 48000 -ac 2 "${out}"`);
fs.unlinkSync(pre);
console.log(`master.wav written (input ${m.input_i} LUFS -> -14 LUFS)`);
