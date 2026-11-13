import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  write(join(dir, 'src', 'motion', 'motion.ts'), `import { x } from './face';\nexport const bell = (t: number) => t;\nexport const DEG = 1;\n`);
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

test('export writes rig, draw, component and the engine files; the copies differ from the source by the header line only', () => {
  const { dir, cfg } = project();
  const doc = run(cfg, join(dir, 'app'));
  assert.equal(doc.ok, true);
  assert.deepEqual([...doc.files].sort(), ['Ball/Ball.draw.ts', 'Ball/Ball.rig.ts', 'Ball/index.tsx', 'Ball/motion/face.ts', 'Ball/motion/motion.ts']);
  assert.match(doc.usage, /ref\.current\?\.fire\('tap'\)/);
  const copy = readFileSync(join(dir, 'app', 'Ball', 'Ball.draw.ts'), 'utf8');
  const [head, ...body] = copy.split('\n');
  assert.match(head, /^\/\/ skac export: src\/Ball\.draw\.ts, skia-motion-agentic-cli 9\.9\.9/);
  assert.equal(body.join('\n'), readFileSync(join(dir, 'src', 'Ball.draw.ts'), 'utf8'));
  assert.match(readFileSync(join(dir, 'app', 'Ball', 'index.tsx'), 'utf8'), /export const Ball = forwardRef/);
});

test('export rewrites engine imports to ./motion/<file> wherever the source kept them', () => {
  const { dir, cfg } = project();
  write(join(dir, 'src', 'Ball.rig.ts'), RIG.replace("'./motion/motion'", "'../src/motion/motion'"));
  run(cfg, join(dir, 'app'));
  assert.match(readFileSync(join(dir, 'app', 'Ball', 'Ball.rig.ts'), 'utf8'), /from '\.\/motion\/motion'/);
  assert.match(readFileSync(join(dir, 'app', 'Ball', 'motion', 'motion.ts'), 'utf8'), /from '\.\/face'/);
});

test('export rewrites side-effect imports, export-from and type-only imports, and refuses a relative import()', () => {
  const { dir, cfg } = project();
  write(join(dir, 'src', 'motion', 'side.ts'), 'export {};\n');
  write(join(dir, 'src', 'Ball.rig.ts'), `import '../src/motion/side';\nexport { DEG } from '../src/motion/motion';\nimport type { x } from '../src/motion/face';\n${RIG}`);
  const doc = run(cfg, join(dir, 'app'));
  assert.ok(doc.files.includes('Ball/motion/side.ts'));
  const rig = readFileSync(join(dir, 'app', 'Ball', 'Ball.rig.ts'), 'utf8');
  assert.match(rig, /^import '\.\/motion\/side';$/m);
  assert.match(rig, /^export \{ DEG \} from '\.\/motion\/motion';$/m);
  assert.match(rig, /^import type \{ x \} from '\.\/motion\/face';$/m);
  write(join(dir, 'src', 'Ball.rig.ts'), `${RIG}export const later = () => { 'worklet'; return import('./motion/face'); };\n`);
  assert.throws(() => run(cfg, join(dir, 'app2')), /loads \.\/motion\/face at run time/);
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
});

test('export refuses an import that is not the scene or the engine', () => {
  const { dir, cfg } = project();
  write(join(dir, 'src', 'other.ts'), 'export const o = 1;\n');
  write(join(dir, 'src', 'Ball.draw.ts'), `import { o } from './other';\n${DRAW}`);
  assert.throws(() => run(cfg, join(dir, 'app')), /neither the scene's own rig\/draw nor a file in a motion\/ folder/);
});

test('export overwrites its own files, and refuses hand-written ones unless --force', () => {
  const { dir, cfg } = project();
  const out = join(dir, 'app');
  run(cfg, out);
  write(join(dir, 'src', 'Ball.draw.ts'), DRAW + '// changed\n');
  run(cfg, out); // our header: overwritten
  assert.match(readFileSync(join(out, 'Ball', 'Ball.draw.ts'), 'utf8'), /changed/);
  writeFileSync(join(out, 'Ball', 'index.tsx'), '// mine\n');
  assert.throws(() => run(cfg, out), (e) => /not written by skac export: index\.tsx/.test(e.message) && /--force/.test(e.hint));
  assert.equal(readFileSync(join(out, 'Ball', 'index.tsx'), 'utf8'), '// mine\n');
  run(cfg, out, { force: true });
  assert.match(readFileSync(join(out, 'Ball', 'index.tsx'), 'utf8'), /^\/\/ skac export:/);
});
