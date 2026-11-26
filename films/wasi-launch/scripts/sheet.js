// Contact sheet of review stills, in time order: node scripts/sheet.js <dir> [cols] -> <dir>/sheet.png
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dir = process.argv[2], cols = +(process.argv[3] || 2);
const files = fs.readdirSync(dir).filter((f) => /^t_.*\.png$/.test(f)).sort((a, b) => parseFloat(a.slice(2)) - parseFloat(b.slice(2)));
const ins = files.map((f) => `-i "${path.join(dir, f)}"`).join(' ');
const sc = files.map((_, i) => `[${i}:v]scale=960:540[v${i}]`).join(';');
const layout = files.map((_, i) => `${(i % cols) * 960}_${Math.floor(i / cols) * 540}`).join('|');
execSync(`ffmpeg -y -hide_banner -loglevel error ${ins} -filter_complex "${sc};${files.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=black" -frames:v 1 "${path.join(dir, 'sheet.png')}"`, { shell: true });
console.log(files.map((f) => f.slice(2, -4)).join(' '), '->', path.join(dir, 'sheet.png'));
