import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { BUILTIN_LIBS, buildWorklet, expandHome, LEFT_OUT, fetchSync, libFiles, readUserLibs, resolveLibs } from '../../src/libs.js';
import { loadTypeScript } from '../../src/lint.js';
import { createProject } from '../../src/scaffold.js';
import { update } from '../../src/update.js';
import { tmp, write } from './helpers.js';
import { installToyBuiltin, TOY_LIB, TOY_LICENSE } from './builtin-fixture.js';

const ts = loadTypeScript({ projectDir: process.cwd() });
const ONETAKE = join(homedir(), '.claude/skills/onetake/lib/motion.js');
const offline = () => ({ code: 1, stdout: '', stderr: 'offline', error: new Error('ENOTFOUND') });
const { fetcher, urls } = installToyBuiltin();
const throwsHint = (fn, message, hint) => assert.throws(fn, (e) => message.test(e.message) && hint.test(e.hint));

// A small IIFE lib with the shapes the real one has: a function, an expression-bodied arrow, an object of arrows, a closure factory,
// a stateful move and one that closes over a `let`.
const FIXTURE = `// toy · © 2026 Someone · Required Notice: Copyright (c) 2026 Someone. Free for tests.
(function (root) {
  'use strict';
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const powOut = (n) => (u) => 1 - Math.pow(1 - u, n);
  const ease = { linear: (u) => u, cubicOut: powOut(3) };
  const seg = (t, t0, t1) => clamp((t - t0) / (t1 - t0));
  let calls = 0;
  function counted(t) { calls += 1; return t * calls; }
  function slide(t, t0, t1, { dist = 100, curve = ease.cubicOut } = {}) { const k = curve(seg(t, t0, t1)); return { k, x: k * dist }; }
  const sim = { run(n) { return { n }; } };
  const OM = { version: '9.9', clamp, ease, seg, slide, counted, sim };
  root.OM = OM;
  if (typeof module === 'object' && module.exports) module.exports = OM;
})(typeof window !== 'undefined' ? window : globalThis);
`;

const load = async (dir, name, code) => {
  const p = join(dir, `${name}.mjs`);
  write(p, code);
  return import(pathToFileURL(p).href + `?${Math.random()}`);
};

// ---- config ----------------------------------------------------------------------------------------------------

test('libs: "~" expands, relative paths are taken from the config file, bad shapes are errors', () => {
  assert.equal(expandHome('~/a/b.js', '/home/x'), '/home/x/a/b.js');
  assert.equal(expandHome('/abs.js', '/home/x'), '/abs.js');
  assert.deepEqual(resolveLibs({ a: '~/m.js', b: 'lib/m.js', c: '/o/m.js' }, '/proj', 'f.json', '/home/x'),
    { a: '/home/x/m.js', b: '/proj/lib/m.js', c: '/o/m.js' });
  assert.deepEqual(resolveLibs(undefined, '/proj'), {});
  throwsHint(() => resolveLibs(['x'], '/p', 'f.json'), /"libs" in f.json is not an object/, /onetake/);
  throwsHint(() => resolveLibs({ 'bad name': 'x' }, '/p'), /not a plain name/, /letters/);
  throwsHint(() => resolveLibs({ a: 3 }, '/p'), /has no path/, /path/);

  const root = tmp();
  write(join(root, 'skia-motion.json'), JSON.stringify({ libs: { toy: 'vendor/toy.js' } }));
  assert.deepEqual(loadConfig(root).libs, { toy: join(root, 'vendor/toy.js') });
  assert.deepEqual(loadConfig(tmp()).libs, {});
});

test('libs: the user default is read from ~/.config/skac/libs.json, nothing without it', () => {
  const saved = process.env.SKAC_LIBS_FILE;
  delete process.env.SKAC_LIBS_FILE;
  try {
    const home = tmp();
    assert.deepEqual(readUserLibs(home), {});
    write(join(home, '.config/skac/libs.json'), '{ "toy": "~/toy.js" }');
    assert.deepEqual(readUserLibs(home), { toy: '~/toy.js' });
    write(join(home, '.config/skac/libs.json'), '{ nope');
    throwsHint(() => readUserLibs(home), /not valid JSON/, /delete the file/);
    write(join(home, '.config/skac/libs.json'), '');
    assert.deepEqual(readUserLibs(home), {}, 'an empty file, as SKAC_LIBS_FILE=/dev/null gives, is no default libs');
    process.env.SKAC_LIBS_FILE = '/dev/null';
    assert.deepEqual(readUserLibs(home), {});
  } finally {
    delete process.env.SKAC_LIBS_FILE;
    if (saved !== undefined) process.env.SKAC_LIBS_FILE = saved;
  }
});

// ---- create, update ---------------------------------------------------------------------------------------------

test('create copies the lib byte for byte, writes its typing and worklet build, and records it in the config', () => {
  const dir = tmp();
  const src = join(dir, 'toy.js');
  write(src, FIXTURE);
  const target = join(dir, 'proj');
  const made = createProject(target, { libs: { toy: src }, fetcher });
  for (const f of ['toy.js', 'toy.d.ts', 'toy.worklet.ts']) assert.ok(made.files.includes(`src/motion/lib/${f}`), f);
  assert.ok(readFileSync(join(target, 'src/motion/lib/toy.js')).equals(readFileSync(src)), 'byte-identical copy');
  assert.match(readFileSync(join(target, 'src/motion/lib/toy.d.ts'), 'utf8'), /declare const OM: Record<string, any>;\nexport default OM;/);
  assert.deepEqual(JSON.parse(readFileSync(join(target, 'skia-motion.json'), 'utf8')).libs, { toy: src });

  // update sees nothing to do, then restores a deleted copy and a changed source.
  const cfg = loadConfig(target);
  assert.deepEqual(Object.keys(cfg.libs), ['toy']);
  const same = update(cfg, { runner: offline, fetcher });
  assert.deepEqual(same.files.filter((f) => f.path.includes('/lib/toy.')).map((f) => f.state), ['same', 'same', 'same']);
  assert.ok(same.files.filter((f) => f.path.includes('/lib/')).every((f) => f.state === 'same'), 'the fetched onetake is unchanged too');
  write(src, FIXTURE.replace("'9.9'", "'9.10'"));
  const next = update(cfg, { runner: offline, fetcher });
  const states = Object.fromEntries(next.files.filter((f) => f.path.includes('/lib/toy.')).map((f) => [f.path.split('/').pop(), f.state]));
  assert.deepEqual(states, { 'toy.js': 'updated', 'toy.d.ts': 'same', 'toy.worklet.ts': 'updated' });
  assert.match(readFileSync(join(target, 'src/motion/lib/toy.worklet.ts'), 'utf8'), /export const version = '9\.10';/);
});

// ---- onetake by fetch -------------------------------------------------------------------------------------------

const GITHUB = 'https://raw.githubusercontent.com/feitangyuan/onetake/abb6d17279cdc749e27e99aa534a062d8fd01ced';

test('the built-in onetake entry is one table: repo, commit and the hashes of the two files', () => {
  assert.equal(JSON.stringify(Object.keys(BUILTIN_LIBS)), '["onetake"]');
  assert.match(readFileSync(new URL('../../src/libs.js', import.meta.url), 'utf8'), /commit: 'abb6d17279cdc749e27e99aa534a062d8fd01ced'/);
});

test('create fetches the lib and its licence from the pinned commit, writes the lib byte for byte and the worklet build', () => {
  const target = join(tmp(), 'proj');
  urls.length = 0;
  const made = createProject(target, { libs: {}, fetcher });
  assert.deepEqual(urls.sort(), [`${GITHUB}/LICENSE`, `${GITHUB}/lib/motion.js`]);
  for (const f of ['onetake.js', 'onetake.LICENSE', 'onetake.d.ts', 'onetake.worklet.ts']) assert.ok(made.files.includes(`src/motion/lib/${f}`), f);
  assert.equal(readFileSync(join(target, 'src/motion/lib/onetake.js'), 'utf8'), TOY_LIB);
  assert.equal(readFileSync(join(target, 'src/motion/lib/onetake.LICENSE'), 'utf8'), TOY_LICENSE);
  assert.match(readFileSync(join(target, 'src/motion/lib/onetake.worklet.ts'), 'utf8'), /Required Notice: Copyright \(c\) 2026 Toy Author[\s\S]*export const clamp/);
  // an update finds the copy by its hash and needs no network
  urls.length = 0;
  const doc = update(loadConfig(target), { runner: offline, fetcher });
  assert.deepEqual(urls, []);
  assert.ok(doc.files.filter((f) => f.path.includes('/onetake.')).every((f) => f.state === 'same'));
});

test('a fetched file with the wrong hash is refused and nothing of the lib is written', () => {
  const target = join(tmp(), 'proj');
  const bad = (url) => Buffer.from(url.endsWith('motion.js') ? TOY_LIB + '// tampered\n' : TOY_LICENSE);
  throwsHint(() => createProject(target, { libs: {}, fetcher: bad }), /lib\/motion\.js fetched from .* has sha256 [0-9a-f]{64}, not the [0-9a-f]{64} skac expects/, /refused, nothing was written/);
  assert.ok(!existsSync(join(target, 'src/motion/lib/onetake.js')));
});

test('a local path under libs overrides the fetch for that name and needs no network', () => {
  const dir = tmp();
  const src = join(dir, 'mine.js');
  write(src, TOY_LIB.replace("'toy'", "'mine'"));
  const never = () => assert.fail('no fetch when a path overrides the name');
  const target = join(dir, 'proj');
  const made = createProject(target, { libs: { onetake: src }, fetcher: never });
  assert.ok(!made.files.some((f) => f.endsWith('.LICENSE')));
  assert.match(readFileSync(join(target, 'src/motion/lib/onetake.worklet.ts'), 'utf8'), /'mine'/);
  assert.equal(update(loadConfig(target), { runner: offline, fetcher: never }).ok, true);
});

test('no network and no override is an error that names the override', () => {
  // a closed local port: the real fetch path runs and fails fast, with no outside network
  throwsHint(() => fetchSync('http://127.0.0.1:1/lib/motion.js'), /could not fetch http:\/\/127\.0\.0\.1:1\/lib\/motion\.js/, /offline: write "libs": \{ "onetake": "<path to onetake's lib\/motion\.js>" \}/);
});

test('a missing lib path is an error with a hint, from create and from update', () => {
  const dir = tmp();
  throwsHint(() => createProject(join(dir, 'p'), { libs: { toy: join(dir, 'nope.js') }, fetcher }), /toy: .*nope\.js does not exist/, /fix the path under "libs"/);
  const proj = tmp();
  write(join(proj, 'skia-motion.json'), JSON.stringify({ libs: { toy: 'gone.js' } }));
  throwsHint(() => update(loadConfig(proj), { runner: offline, fetcher }), /does not exist/, /remove the lib/);
});

// ---- the worklet build ------------------------------------------------------------------------------------------

test('worklet build of the fixture: every function carries worklet, state is left out and listed, results equal the original', async () => {
  const dir = tmp();
  const { code, exports, leftOut } = buildWorklet(ts, FIXTURE, { name: 'toy', srcName: 'toy.js', notice: 'Required Notice: Copyright (c) 2026 Someone. Free for tests.' });
  assert.deepEqual(exports, ['version', 'clamp', 'ease', 'seg', 'slide']);
  assert.deepEqual(leftOut.map((l) => l.name).sort(), ['counted', 'sim']);
  assert.match(leftOut.find((l) => l.name === 'counted').why, /closes over calls/);
  assert.ok(code.startsWith('// toy · © 2026 Someone'), 'the lib header stays first');
  assert.match(code, /Required Notice: Copyright \(c\) 2026 Someone/);
  assert.doesNotMatch(code, /let calls|function counted|const sim/);
  assert.match(code, /export const clamp = \(v, a = 0, b = 1\) => \{ 'worklet'; return /);
  assert.match(code, /const powOut = \(n\) => \{ 'worklet'; return \(u\) => \{ 'worklet'; return /, 'nested closures are worklets too');
  const W = await load(dir, 'toy.worklet', code);
  const O = createRequire(import.meta.url)(write(join(dir, 'toy.cjs'), FIXTURE) ?? join(dir, 'toy.cjs'));
  for (const t of [0, 0.3, 0.7, 1, 2]) assert.deepEqual(W.slide(t, 0.2, 1.2), O.slide(t, 0.2, 1.2));
  assert.equal(W.ease.cubicOut(0.4), O.ease.cubicOut(0.4));
});

test('a lib that is not one wrapped function call, or has no OM object, is an error with a hint', () => {
  throwsHint(() => buildWorklet(ts, 'export const a = 1;', { name: 'x' }), /not a library wrapped/, /\(function \(root\)/);
  throwsHint(() => buildWorklet(ts, '(function (r) { const a = () => 1; })(this);', { name: 'x' }), /no const OM/, /OM object literal/);
});

// ---- golden: the worklet build of onetake equals onetake ---------------------------------------------------------

const T = [0, 0.25, 0.6, 1.0, 1.4, 2.0, 3.0]; // before, inside and after the 0.5 s to 1.5 s windows below
const A = { x: 100, y: 120, w: 200, h: 60, r: 8 };
const B = { x: 0, y: 0, w: 390, h: 800, r: 0 };
const KNOTS = [{ t: 0, x: 0, y: 0 }, { t: 1, x: 300, y: 120 }, { t: 2, x: 120, y: 400 }];
const KEYS = [{ t: 0, x: 960, y: 540, zoom: 1 }, { t: 1, x: 400, y: 300, zoom: 2, rot: 0.1 }, { t: 2, x: 700, y: 500, zoom: 1.5 }];
const CARD = { x: 0, y: 0, w: 300, h: 200 };
// name -> argument lists for time t, built from the lib under test (so a curve or a camera comes from that same build)
const CASES = {
  clamp: (L, t) => [[t - 1, 0, 1], [t, 0.5, 1.5]],
  lerp: (L, t) => [[0, 10, t / 3]],
  seg: (L, t) => [[t, 0.5, 1.5], [t, 1, 1]],
  sstep: (L, t) => [[0.5, 1.5, t]],
  ssstep: (L, t) => [[0.5, 1.5, t]],
  bezier: (L, t) => [[0.25, 0.1, 0.25, 1], [0.7, 0, 0.3, 1]],
  tween: (L, t) => [[t, 0.5, 1.5], [t, 0.5, 1.5, L.ease.cubicOut]],
  t80: (L, t) => [[L.ease.smooth], [L.ease.quartOut, 0.5]],
  spring: (L, t) => [[t - 0.5, 0.6, 20], [t - 0.5, 1, 18], [t - 0.5, 1.5, 14]],
  springVel: (L, t) => [[t - 0.5, 0.6, 20], [t - 0.5, 1, 18], [t - 0.5, 1.5, 14]],
  ring: (L, t) => [[t - 0.5], [t - 0.5, 5, 30]],
  settle: (L, t) => [[0.6, 20], [0.9, 12, 0.05]],
  spline: (L, t) => [[KNOTS, t]],
  rng: (L, t) => [[1], [42]],
  wordRise: (L, t) => [[t, 0.5], [t, 0.5, { zeta: 0.8, dist: 40 }]],
  letterDrop: (L, t) => [[t, 0.5, 0], [t, 0.5, 3, { stagger: 0.1 }]],
  popIn: (L, t) => [[t, 0.5]],
  liftOut: (L, t) => [[t, 0.5], [t, 0.5, { dur: 0.5, dist: 40 }]],
  maskRise: (L, t) => [[t, 0.5, 0], [t, 0.5, 2, { dist: 24 }]],
  typeOn: (L, t) => [[t, 0.5, 'hello world']],
  tick: (L, t) => [[t, 0.8]],
  flyThrough: (L, t) => [[t, 0.5, 1]],
  morphRect: (L, t) => [[t, 0.5, 1.5, A, B], [t, 0.5, 1.5, A, B, { curve: L.ease.smoother }], [t, 0.5, 1.5, A, B, { spring: { zeta: 0.7, omega: 16 } }]],
  iris: (L, t) => [[t, 0.5, 1.5, 300, 400], [t, 0.5, 1.5, 100, 100, { W: 390, H: 800 }]],
  zoomThrough: (L, t) => [[t, 0.5, 1.5, CARD], [t, 0.5, 1.5, CARD, { fit: 'contain' }]],
  hop: (L, t) => [[t, 0.5, 1.5, { x: 0, y: 0 }, { x: 300, y: 100 }], [t, 0.5, 1.5, { x: 0, y: 0 }, { x: 300, y: 100 }, { height: 80 }]],
  gather: (L, t) => [[t, 0.5, 1.5, 0, 5, { x: 0, y: 0 }, { x: 200, y: 200 }], [t, 0.5, 1.5, 3, 5, { x: 0, y: 0 }, { x: 200, y: 200 }]],
  ribbon: (L, t) => [[t, [0.5, 1.2]]],
  seal: (L, t) => [[t, 0.5, 1.5]],
  staccato: (L, t) => [[t, [[0.2, 'a'], [0.8, 'b'], [1.4, 'c']]]],
  impact: (L, t) => [[t, 0.6], [t, 0.6, { decay: 5, sqx: 0.2 }]],
  impactSplit: (L, t) => [[t, 0.6, 100, 300], [t, 0.6, 500, 300]],
  press: (L, t) => [[t, 0.5], [t, 0.5, { depth: 0.1 }]],
  cursor: (L, t) => [[t, KNOTS, [0.5, 1.5]]],
  squash: (L, t) => [[t * 300, t * 100], [-t * 200, 40, { k: 0.002 }]],
  camera: (L, t) => [[t, KEYS], [t, KEYS, { W: 390, H: 800 }]],
  view: (L, t) => [[L.camera(t, KEYS)], [L.camera(t, KEYS), { depth: 0.8 }]],
  dof: (L, t) => [[t / 3], [t, 0.5, { k: 4 }]],
  whip: (L, t) => [[t, 0.5, 0.8, 500]],
  shake: (L, t) => [[t, 0.5], [t, 0.5, { amp: 20, seed: 3 }]],
  drift: (L, t) => [[t, 0.5, 1.5], [t, 0.5, 1.5, 0.1]],
  project: (L, t) => [[L.view(L.camera(t, KEYS)), 200, 300]],
  unproject: (L, t) => [[L.view(L.camera(t, KEYS)), 200, 300]],
  projectBox: (L, t) => [[L.view(L.camera(t, KEYS)), { x: 10, y: 20, w: 300, h: 100, op: 1 }]],
  screenTravel: (L, t) => [[L.camera(0, KEYS), L.camera(t, KEYS), L.camera(t / 2, KEYS)]],
  swiftSpring: (L, t) => [[t - 0.5, 'snappy'], [t - 0.5, 'bouncy', { duration: 0.7 }], [t - 0.5, 'smooth']],
  lightField: (L, t) => [[t / 3], [t / 3, { W: 390, H: 800 }]],
  ripple: (L, t) => [[t, 0.5], [t, 0.5, { n: 4, rMax: 600 }]],
};
const U = [0, 0.1, 0.35, 0.5, 0.8, 1];

/** Equal to 1e-9; a function is compared by calling it on U (curves and generators). */
const same = (a, b, path) => {
  if (typeof a === 'number' && typeof b === 'number') {
    assert.ok((Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-9, `${path}: ${a} vs ${b}`);
  } else if (typeof a === 'function' && typeof b === 'function') {
    U.forEach((u) => same(a(u), b(u), `${path}(${u})`));
  } else if (a && b && typeof a === 'object') {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(a)) same(a[k], b[k], `${path}.${k}`);
  } else assert.deepEqual(a, b, path);
};

test('golden: every export of the onetake worklet build equals the original, to 1e-9, at several times', { skip: !existsSync(ONETAKE) && 'onetake is not installed on this machine' }, async () => {
  const dir = tmp();
  const source = readFileSync(ONETAKE, 'utf8');
  const { exports, leftOut } = buildWorklet(ts, source, { name: 'onetake', srcName: 'motion.js' });
  const code = libFiles(ts, 'onetake', ONETAKE).get('src/motion/lib/onetake.worklet.ts'); // what create writes, notice and all
  const O = createRequire(import.meta.url)(ONETAKE);
  const W = await load(dir, 'onetake.worklet', code);

  // The exports are the OM keys minus the left-out ones, and the header lists exactly those.
  assert.deepEqual(Object.keys(W).sort(), [...exports].sort());
  assert.deepEqual(Object.keys(O).filter((k) => !(k in W)).sort(), leftOut.map((l) => l.name).sort());
  assert.deepEqual(leftOut.map((l) => l.name).sort(), Object.keys(LEFT_OUT).sort());
  const listed = [...code.matchAll(/^\/\/   (\w+): /gm)].map((m) => m[1]).sort();
  assert.deepEqual(listed, leftOut.map((l) => l.name).sort(), 'the header lists what is left out');
  assert.match(code, /Required Notice: Copyright \(c\) 2026 Patrick/);

  // Every function in the build, nested ones too, starts with 'worklet'.
  const sf = ts.createSourceFile('w.ts', code, ts.ScriptTarget.Latest, true);
  let fns = 0;
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
      const first = ts.isBlock(n.body) ? n.body.statements[0] : null;
      assert.ok(first && ts.isExpressionStatement(first) && first.expression.text === 'worklet', `function at ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} lacks 'worklet'`);
      fns += 1;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(fns > 60, `${fns} functions`);

  let calls = 0;
  for (const name of Object.keys(W)) {
    if (name === 'version' || name === 'lineage') { assert.equal(W[name], O[name]); calls += 1; continue; }
    if (name === 'ease') {
      for (const k of Object.keys(O.ease)) {
        if (k === 'back') { same(O.ease.back(2), W.ease.back(2), 'ease.back(2)'); same(O.ease.back(), W.ease.back(), 'ease.back()'); } else same(O.ease[k], W.ease[k], `ease.${k}`);
        calls += 1;
      }
      continue;
    }
    assert.ok(CASES[name], `no golden case for the export ${name}: add one to CASES`);
    for (const t of T) {
      const oa = CASES[name](O, t);
      const wa = CASES[name](W, t);
      oa.forEach((args, i) => { same(O[name](...args), W[name](...wa[i]), `${name}@${t}#${i}`); calls += 1; });
    }
  }
  assert.ok(calls >= 3 * Object.keys(W).length, `${calls} calls`);
  console.log(`golden: ${Object.keys(W).length} exports, ${calls} comparisons, ${fns} worklet functions`);
});

test('the real onetake build leaves out the four stateful moves and nothing else', { skip: !existsSync(ONETAKE) && 'onetake is not installed on this machine' }, () => {
  const { leftOut, exports } = buildWorklet(ts, readFileSync(ONETAKE, 'utf8'), { name: 'onetake' });
  assert.deepEqual(leftOut.map((l) => l.name).sort(), ['carouselLoop', 'lattice', 'silk', 'sim']);
  assert.equal(exports.length, 51);
});
