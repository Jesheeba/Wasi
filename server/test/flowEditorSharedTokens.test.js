// Flow editor uses the shared design tokens instead of its own copy.
// The editor runs in an iframe, so it never inherits the CRM page's CSS; it
// must link /breakpoints.css itself and map every --wf-* colour onto those
// tokens. Static checks only - no DB, no server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FE = path.join(__dirname, '..', '..', 'flow-editor');
const read = (rel) => fs.readFileSync(path.join(FE, rel), 'utf8');
const HEX = /#[0-9a-fA-F]{3,8}\b/;

test('flow editor links the shared token stylesheet, unbundled', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="stylesheet" href="\/breakpoints\.css" vite-ignore \/>/);
});

test('every shared-palette --wf-* variable resolves through a shared token', () => {
  const css = read('src/styles.css');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  // Editor-specific on purpose (documented in styles.css): canvas tint,
  // text-on-accent, and the two branch colours with no shared equivalent.
  const allowedLiteral = new Set(['--wf-bg', '--wf-on-accent', '--wf-edge-button-id', '--wf-edge-default']);
  for (const [, name, value] of root.matchAll(/(--wf-[\w-]+):\s*([^;]+);/g)) {
    if (allowedLiteral.has(name) || !HEX.test(value)) continue;
    assert.match(value, /^var\(--[\w-]+, #[0-9a-fA-F]+\)$/, `${name} must be var(--token, fallback), got "${value}"`);
  }
});

test('no hardcoded colours outside the :root token block', () => {
  const css = read('src/styles.css');
  const rootEnd = css.indexOf('}', css.indexOf(':root {'));
  const body = css.slice(rootEnd + 1).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!HEX.test(body), `styles.css rule contains a literal colour: ${body.match(HEX)?.[0]}`);
  for (const f of ['src/constants.js', 'src/ConditionEdge.jsx', 'src/FlowNodeCard.jsx', 'src/App.jsx']) {
    const src = read(f).replace(/&#\d+;/g, '');
    assert.ok(!/['"]#[0-9a-fA-F]{3,8}['"]/.test(src), `${f} contains a literal colour`);
  }
});

test('the main app serves /breakpoints.css and the Dockerfile ships it', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(app, /app\.get\('\/breakpoints\.css'/);
  const docker = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
  assert.match(docker, /COPY [^\n]*\bbreakpoints\.css\b/);
});
