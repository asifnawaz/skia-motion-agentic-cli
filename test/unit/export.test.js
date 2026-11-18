import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { exportScene } from '../../src/export.js';
import { add } from '../../src/project.js';
import { CliError } from '../../src/util.js';
import { tmp, write } from './helpers.js';

const ROOT = `import { Composition } from 'remotion';
export const Root = () => <>
</>;
`;
const RIG = `import { bell } from './motion/motion';
export type Channels = ReturnType<typeof rig>['channels'];
export type RigEvent = { name: string; at: number };
export const meta = { fps: 60, frames: 60, events: [], beats: [] };
export function rig(ms: number) { 'worklet'; return { channels: { x: bell(ms) } }; }
`;
const DRAW = `import type { Channels } from './Ball.rig';
import { DEG } from './motion/motion';
export function draw(canvas: any, ch: Channels) { 'worklet'; return DEG + ch.x; }
`;

// A project with a scene that may be exported; `scaffold` adds the draw file and the engine folder.
const project = ({ draw = true } = {}) => {
  const dir = tmp();
  write(join(dir, 'skia-motion.json'), JSON.stringify({ root: 'src/Root.tsx', out: 'out' }));
  write(join(dir, 'src', 'Root.tsx'), `import { Composition } from 'remotion';\nexport const Root = () => <>\n</>;\n`);
  const cfg = loadConfig(dir);
  add(cfg, 'Ball', { draw });
  write(join(dir, 'src', 'Ball.rig.ts'), RIG);
  if (draw) write(join(dir, 'src', 'Ball.draw.ts'), DRAW);
  write(join(dir, 'src', 'motion', 'motion.ts'), `import { x } from './face';\nexport const bell = (t: number) => { 'worklet'; return t; };\nexport const DEG = 1;\n`);
  write(join(dir, 'src', 'motion', 'face.ts'), `export const x = 1;\n`);
  return { dir, cfg };
};
const ok = () => ({ ok: true });
const run = (cfg, out, opts = {}, checkFn = ok) => exportScene(cfg, 'Ball', { dir: out, version: '9.9.9', ...opts }, {}, checkFn);

test('add --draw scaffolds rig, draw and a Picture composition; plain add makes no draw file', () => {
  const { dir } = project();
  assert.ok(existsSync(join(dir, 'src', 'Ball.draw.ts')));
  assert.match(readFileSync(join(dir, 'src', 'Ball.tsx'), 'utf8'), /draw\(canvas, rig\(ms, events\)/);
  const plain = project({ draw: false });
  assert.ok(!existsSync(join(plain.dir, 'src', 'Ball.draw.ts')));
  assert.match(readFileSync(join(plain.dir, 'src', 'Ball.rig.ts'), 'utf8'), /'worklet'/); // the rig template carries the directive
});

test('export refuses with the check failures when --check is not ok, and writes nothing', () => {
  const { dir, cfg } = project();
  const out = join(dir, 'app');
  const bad = () => ({ ok: false, failures: [{ ruleId: 'skac/speed-cap' }] });
  assert.throws(() => run(cfg, out, {}, bad), (e) => e instanceof CliError && /does not pass --check/.test(e.message) && e.extra?.failures?.[0].ruleId === 'skac/speed-cap');
  assert.ok(!existsSync(out));
});

test('export refuses with a hint when there is no draw.ts', () => {
  const { dir, cfg } = project({ draw: false });
  assert.throws(() => run(cfg, join(dir, 'app')), (e) => e instanceof CliError && /no Ball\.draw\.ts/.test(e.message) && /add <Name> --draw/.test(e.hint));
});

const bundleText = (dir) => readFileSync(join(dir, 'app', 'Ball.tsx'), 'utf8');

test('export writes exactly one file: the component, rig, draw and only the engine declarations the scene reaches', () => {
  const { dir, cfg } = project();
  write(join(dir, 'src', 'motion', 'motion.ts'),
    `import { x } from './face';\nexport const bell = (t: number) => { 'worklet'; return t + x; };\nexport const DEG = 1;\nexport const UNUSED = 2;\nexport function never(t: number) { 'worklet'; return t; }\n`);
  const doc = run(cfg, join(dir, 'app'));
  assert.equal(doc.ok, true);
  assert.deepEqual(doc.files, ['Ball.tsx']);
  assert.deepEqual(readdirSync(join(dir, 'app')), ['Ball.tsx']);
  assert.match(doc.usage, /from '\.\/app\/Ball'/);
  assert.match(doc.usage, /ref\.current\?\.fire\('tap'\)/);
  const text = bundleText(dir);
  assert.match(text.split('\n')[0], /^\/\/ skac export: src\/motion\/face\.ts, src\/motion\/motion\.ts, src\/Ball\.rig\.ts, src\/Ball\.draw\.ts, templates\/app\/component\.tsx\.tmpl, skia-motion-agentic-cli 9\.9\.9/);
  assert.match(text, /export const Ball = forwardRef/);
  assert.match(text, /const bell = /);
  assert.match(text, /const DEG = 1/);
  assert.doesNotMatch(text, /UNUSED|function never/); // not reached, not bundled
  assert.doesNotMatch(text, /from '\.\//); // no relative import survives
  assert.doesNotMatch(text, /export const bell/); // engine exports are plain declarations in the bundle
  assert.ok(text.indexOf('const x = 1') < text.indexOf('const bell')); // dependencies first
});

test('export reads imports wherever the source kept them, and drops a side-effect import of a module with no code', () => {
  const { dir, cfg } = project();
  write(join(dir, 'src', 'Ball.rig.ts'), RIG.replace("'./motion/motion'", "'../src/motion/motion'"));
  run(cfg, join(dir, 'app'));
  assert.match(bundleText(dir), /const bell = /);
  write(join(dir, 'src', 'motion', 'side.ts'), 'export {};\n');
  write(join(dir, 'src', 'Ball.rig.ts'), `import '../src/motion/side';\nexport { DEG } from '../src/motion/motion';\nimport type { x } from '../src/motion/face';\n${RIG}`);
  run(cfg, join(dir, 'app'));
  const text = bundleText(dir);
  assert.doesNotMatch(text, /side/);
  assert.match(text, /^export \{ DEG \};$/m);
  write(join(dir, 'src', 'Ball.rig.ts'), `${RIG}export const later = () => { 'worklet'; return import('./motion/face'); };\n`);
  assert.throws(() => run(cfg, join(dir, 'app2')), /loads \.\/motion\/face at run time/);
});

test('export renames a top-level name two files share and rewrites its references, shorthand and destructuring included', () => {
  const { dir, cfg } = project();
  write(join(dir, 'src', 'motion', 'motion.ts'),
    `export const clamp = (v: number) => { 'worklet'; return Math.min(v, 1); };\nexport const pack = (clamp: number) => { 'worklet'; return { clamp }; };\n`);
  write(join(dir, 'src', 'Ball.rig.ts'),
    `import { clamp as cl, pack } from './motion/motion';\nexport type Channels = ReturnType<typeof rig>['channels'];\nexport type RigEvent = { name: string; at: number };\nexport const meta = { fps: 60, frames: 60, events: [], beats: [] };\n`
    + `const clamp = (v: number) => { 'worklet'; return v; };\nexport function rig(ms: number) { 'worklet'; return { channels: { x: clamp(ms) + cl(ms), p: pack(1).clamp } }; }\n`);
  write(join(dir, 'src', 'Ball.draw.ts'), `import type { Channels } from './Ball.rig';\nexport function draw(canvas: any, ch: Channels) { 'worklet'; return ch.x; }\n`);
  run(cfg, join(dir, 'app'));
  const text = bundleText(dir);
  assert.match(text, /const clamp = \(v: number\) => \{ 'worklet'; return v; \}/); // the scene's own keeps its name
  assert.match(text, /const clamp_motion = \(v: number\) => \{ 'worklet'; return Math\.min/);
  assert.match(text, /clamp\(ms\) \+ clamp_motion\(ms\)/);
  assert.match(text, /pack = \(clamp_motion: number\) => \{ 'worklet'; return \{ clamp: clamp_motion \}; \}/); // a shadowing parameter follows the rename; the shorthand keeps its property name
  assert.match(text, /pack\(1\)\.clamp/); // a property name is never renamed
});

test('export keeps a library block under its own header and Required Notice, and puts @ts-nocheck at the top', () => {
  const { dir, cfg } = project();
  write(join(dir, 'src', 'motion', 'lib', 'onetake.worklet.ts'),
    `// onetake motion library (MIT)\n// Required Notice: Copyright (c) Someone\n// skac libs: generated\n// @ts-nocheck\n\nexport function morphRect(t) { 'worklet'; return t; }\nexport function other(t) { 'worklet'; return t; }\n`);
  write(join(dir, 'src', 'Ball.rig.ts'), `import { morphRect } from './motion/lib/onetake.worklet';\n${RIG.replace('bell(ms)', 'morphRect(ms)').replace("import { bell } from './motion/motion';\n", '')}`);
  write(join(dir, 'src', 'Ball.draw.ts'), `import type { Channels } from './Ball.rig';\nexport function draw(canvas: any, ch: Channels) { 'worklet'; return ch.x; }\n`);
  const doc = run(cfg, join(dir, 'app'));
  const text = bundleText(dir);
  assert.deepEqual(doc.files, ['Ball.tsx']);
  const lines = text.split('\n');
  assert.equal(lines[1], '// @ts-nocheck');
  assert.ok(text.indexOf('// Required Notice: Copyright (c) Someone') < text.indexOf('function morphRect'));
  assert.equal(text.split('// @ts-nocheck').length, 2);
  assert.doesNotMatch(text, /function other/);
});

test('export refuses a rig or draw without a leading worklet directive, or one importing Reanimated', () => {
  const { dir, cfg } = project();
  const checked = [];
  const spy = () => (checked.push(1), { ok: true });
  write(join(dir, 'src', 'Ball.draw.ts'), DRAW.replace(" 'worklet';", ''));
  assert.throws(() => run(cfg, join(dir, 'app'), {}, spy), (e) => /draw\(\) in Ball\.draw\.ts does not start with 'worklet'/.test(e.message) && /UI thread/.test(e.hint));
  write(join(dir, 'src', 'Ball.draw.ts'), DRAW);
  write(join(dir, 'src', 'Ball.rig.ts'), RIG.replace("{ 'worklet'; return", '{ const a = 1; \'worklet\'; return'));
  assert.throws(() => run(cfg, join(dir, 'app'), {}, spy), /rig\(\) in Ball\.rig\.ts does not start with 'worklet'/);
  write(join(dir, 'src', 'Ball.rig.ts'), `import { useSharedValue } from 'react-native-reanimated';\n${RIG}`);
  assert.throws(() => run(cfg, join(dir, 'app'), {}, spy), /Ball\.rig\.ts imports react-native-reanimated/);
  write(join(dir, 'src', 'Ball.rig.ts'), `${RIG}const helper = (t: number) => t * 2;\n`);
  assert.throws(() => run(cfg, join(dir, 'app'), {}, spy), /helper\(\) in Ball\.rig\.ts does not start with 'worklet'/);
  assert.equal(checked.length, 0); // refused before --check runs
  write(join(dir, 'src', 'Ball.rig.ts'), RIG);
  write(join(dir, 'src', 'motion', 'face.ts'), `import { useSharedValue } from 'react-native-reanimated';\nexport const x = 1;\n`);
  assert.throws(() => run(cfg, join(dir, 'app'), {}, spy), /face\.ts imports react-native-reanimated/); // engine files too
  assert.ok(!existsSync(join(dir, 'app')));
  // an exported engine function without the directive is refused too; a non-exported helper is the rig's to call, not checked
  write(join(dir, 'src', 'motion', 'face.ts'), `export const x = 1;\nexport function blink(t: number) { return t; }\n`);
  assert.throws(() => run(cfg, join(dir, 'app'), {}, spy), (e) => /blink\(\) in motion\/face\.ts does not start with 'worklet'/.test(e.message) && /UI thread/.test(e.hint));
  write(join(dir, 'src', 'motion', 'face.ts'), `export const x = 1;\nexport const y = (t: number) => t * 2;\n`);
  assert.throws(() => run(cfg, join(dir, 'app'), {}, spy), /y\(\) in motion\/face\.ts does not start with 'worklet'/);
  write(join(dir, 'src', 'motion', 'face.ts'), `export const x = 1;\nconst helper = (t: number) => t;\nexport function ok(t: number) { 'worklet'; return helper(t); }\n`);
  run(cfg, join(dir, 'app'), {}, spy);
  assert.ok(existsSync(join(dir, 'app')));
});

test('export refuses an import that is not the scene or the engine', () => {
  const { dir, cfg } = project();
  write(join(dir, 'src', 'other.ts'), 'export const o = 1;\n');
  write(join(dir, 'src', 'Ball.draw.ts'), `import { o } from './other';\n${DRAW}`);
  assert.throws(() => run(cfg, join(dir, 'app')), /neither the scene's own rig\/draw nor a file in a motion\/ folder/);
});

test('export overwrites its own file, and refuses a hand-written one unless --force', () => {
  const { dir, cfg } = project();
  const out = join(dir, 'app');
  run(cfg, out);
  write(join(dir, 'src', 'Ball.draw.ts'), DRAW + 'export const changed = 3;\n');
  run(cfg, out); // our header: overwritten
  assert.match(readFileSync(join(out, 'Ball.tsx'), 'utf8'), /changed/);
  writeFileSync(join(out, 'Ball.tsx'), '// mine\n');
  assert.throws(() => run(cfg, out), (e) => /was not written by skac export/.test(e.message) && /--force/.test(e.hint));
  assert.equal(readFileSync(join(out, 'Ball.tsx'), 'utf8'), '// mine\n');
  run(cfg, out, { force: true });
  assert.match(readFileSync(join(out, 'Ball.tsx'), 'utf8'), /^\/\/ skac export:/);
});
