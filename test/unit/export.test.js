import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { execute } from '../../src/cli.js';
import { loadConfig } from '../../src/config.js';
import { PACKAGE_ROOT } from '../../src/docs.js';
import { exportScene } from '../../src/export.js';
import { add } from '../../src/project.js';
import { writeManifest } from '../../src/update.js';
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

test('export rejects installed v2 even if the target declares v3, and accepts v3 and newer', () => {
  const { dir, cfg } = project();
  const app = tmp('app-');
  const out = join(app, 'src', 'motion');
  const name = 'react-native-skia';
  const installed = join(app, 'node_modules', name, 'package.json');
  write(join(app, 'package.json'), JSON.stringify({ dependencies: { [name]: '^3.0.0' } }));
  write(installed, JSON.stringify({ name, version: '2.15.0' }));

  const result = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'bin', 'skac.js'), 'Ball', '--export', out], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, false);
  assert.match(json.error, /^react-native-skia 2\.15\.0.*>=3\.0\.0/);
  assert.ok(!existsSync(out));

  for (const version of ['3.0.0', '3.10.2']) {
    write(installed, JSON.stringify({ name, version }));
    assert.equal(run(cfg, out).ok, true, version);
  }
});

test('export checks the declared Skia range without an install and supports an alias to v3', () => {
  const { cfg } = project();
  const app = tmp('app-');
  const out = join(app, 'src');
  const manifest = join(app, 'package.json');
  const declare = (name, specifier) => write(manifest, JSON.stringify({ dependencies: { [name]: specifier } }));
  declare('react-native-skia', '^2.15.0');
  assert.throws(() => run(cfg, out), /\^2\.15\.0.*>=3\.0\.0/);
  declare('@shopify/react-native-skia', '2.14.0');
  assert.throws(() => run(cfg, out), /2\.14\.0.*>=3\.0\.0/);
  declare('react-native-skia', '^3.0.0');
  assert.equal(run(cfg, out).ok, true);
  declare('@shopify/react-native-skia', 'npm:react-native-skia@^3.10.0');
  assert.equal(run(cfg, out).ok, true);
});

test('an explicit Skia package or npm alias controls the export import and version check', () => {
  const { dir, cfg } = project();
  const app = tmp('app-');
  const out = join(app, 'src');
  const scoped = '@shopify/react-native-skia';
  const unscoped = 'react-native-skia';
  const alias = 'app-skia';
  const declare = (dependencies) => write(join(app, 'package.json'), JSON.stringify({ dependencies }));
  const configure = (skia) => {
    write(join(dir, 'skia-motion.json'), JSON.stringify({ app: { skia } }));
    return loadConfig(dir);
  };
  const generated = () => readFileSync(join(out, 'Ball.tsx'), 'utf8');

  declare({ [unscoped]: '3.10.2', [scoped]: '2.14.0' });
  run(cfg, out);
  assert.ok(generated().includes(`from '${unscoped}'`));
  assert.throws(() => run(configure(scoped), out), /2\.14\.0.*>=3\.0\.0/);

  const aliasCfg = configure(alias);
  declare({ [alias]: `npm:${scoped}@2.14.0` });
  assert.throws(() => run(aliasCfg, out), /app-skia.*2\.14\.0.*>=3\.0\.0/);
  write(join(app, 'node_modules', alias, 'package.json'), JSON.stringify({ name: unscoped, version: '3.0.0' }));
  run(aliasCfg, out);
  assert.ok(generated().includes(`from '${alias}'`));
});

test('an explicit Skia subpath keeps its import and checks the package root', () => {
  const { dir } = project();
  const out = join(dir, 'app');
  const config = join(dir, 'skia-motion.json');
  const name = 'react-native-skia';
  const specifier = `${name}/lib/module`;
  write(config, JSON.stringify({ app: { skia: specifier } }));
  const cfg = loadConfig(dir);
  const installed = join(out, 'node_modules', name, 'package.json');
  write(installed, JSON.stringify({ name, version: '2.15.0' }));
  assert.throws(() => run(cfg, out), /2\.15\.0.*>=3\.0\.0/);
  write(installed, JSON.stringify({ name, version: '3.0.0' }));
  assert.equal(run(cfg, out).ok, true);
  assert.ok(bundleText(dir).includes(`from '${specifier}'`));
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

// ---- machine scenes ----
const MACHINE = readFileSync(join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', 'fixtures', 'machines', 'invite.machine.json'), 'utf8');
const MCLIPS = `import { lift } from './numbers';
import { EASE_OUT } from './motion/motion';
export const clips = {
  rest: { ms: 1, play(ms: number) { 'worklet'; return { channels: { y: 0, r: 0 } }; } },
  bounce: { ms: 500, play(ms: number) { 'worklet'; return { channels: { y: lift(ms) * EASE_OUT(ms / 500), r: 0 } }; } },
  call: { ms: 2000, play(ms: number) { 'worklet'; return { channels: { r: ms / 2000 } }; } },
  still: { ms: 1, play(ms: number) { 'worklet'; return { channels: { r: 0 } }; } },
};
`;
const MDRAW = `import type { SkCanvas } from '@shopify/react-native-skia';
import type { Pose } from './motion/machine';
export function draw(canvas: SkCanvas, ch: Pose['channels'], size: { width: number; height: number }) { 'worklet'; return [canvas, ch, size]; }
`;
const machineProject = ({ clips = MCLIPS, config = {} } = {}) => {
  const { dir } = project();
  write(join(dir, 'skia-motion.json'), JSON.stringify({ root: 'src/Root.tsx', out: 'out', ...config }));
  write(join(dir, 'src', 'Ball.machine.json'), MACHINE);
  write(join(dir, 'src', 'Ball.clips.ts'), clips);
  write(join(dir, 'src', 'Ball.draw.ts'), MDRAW);
  write(join(dir, 'src', 'numbers.ts'), `export function lift(ms: number) { 'worklet'; return -ms / 50; }\n`);
  for (const f of ['motion.ts', 'machine.ts', 'face.ts']) write(join(dir, 'src', 'motion', f), readFileSync(join(PACKAGE_ROOT, 'templates', 'motion', f), 'utf8'));
  return { dir, cfg: loadConfig(dir) };
};

test('a machine scene bundles its machine, clips, draw and helpers in one file and imports the engine from the runtime', () => {
  const { dir, cfg } = machineProject({ config: { app: { skia: 'react-native-skia' } } });
  write(join(dir, 'src', 'Ball.draw.ts'), `import { blinkKeys } from './motion/face';\n${MDRAW.replace('return [canvas, ch, size]', 'return [canvas, ch, size, blinkKeys([], 1)]')}`);
  const out = join(dir, 'app');
  const r = run(cfg, out);
  assert.equal(r.machine, true);
  assert.equal(r.dir, out);
  assert.deepEqual(r.files, ['Ball.tsx']);
  assert.deepEqual(readdirSync(out), ['Ball.tsx']);
  assert.match(r.usage, /from '\.\/app\/Ball'/);
  assert.ok(r.needs.includes('react-native-skia (Skia >=3.0.0)'));
  const text = bundleText(dir);
  assert.match(text, /^\/\/ skac export: .*Ball\.machine\.json.*numbers\.ts.*skia-motion-agentic-cli 9\.9\.9/);
  assert.match(text, /function lift\(ms: number\) \{ 'worklet'; return -ms \/ 50; \}/);
  assert.match(text, /const clips = \{/);
  assert.match(text, /function draw\(canvas: SkCanvas/);
  assert.match(text, /export const Ball = forwardRef/);
  const runtimeImports = text.match(/^import .* from 'skia-motion-agentic-cli\/runtime';$/gm);
  assert.equal(runtimeImports.length, 1);
  for (const name of ['EASE_OUT', 'blinkKeys', 'type Pose', 'useMachine', 'type Machine']) assert.ok(runtimeImports[0].includes(name));
  assert.doesNotMatch(text, /function (?:bezier|machineRig|compile|blinkKeys)\(|const EASE_OUT =|from ['"]\./);
  assert.match(text, /^import \{.*type SkCanvas.*\} from 'react-native-skia';$/m);
  assert.match(text, /MachineHandle<typeof machine>/);
  assert.match(text, /useMachine\(machine, clips, \{ [^}]*exportedBy \}\)/);
  assert.match(text, /const exportedBy = "9\.9\.9";/);
  assert.deepEqual(JSON.parse(text.match(/const machine = (.+) as const satisfies Machine;/s)[1]), JSON.parse(MACHINE));
});

test('machine export uses update states for edited, previously managed and missing engine files', () => {
  const { dir, cfg } = machineProject();
  const out = join(dir, 'app');
  const path = 'src/motion/motion.ts';
  const file = join(dir, path);
  write(file, `${readFileSync(file, 'utf8')}export const MINE = 1;\n`);
  const refuses = (state) => assert.throws(() => run(cfg, out), (e) => e instanceof CliError
    && e.message.includes(`${path} is not current (${state})`) && e.hint.includes('skac update'));
  refuses('kept-edited');
  writeManifest(dir, [path]); // The old bytes were once supplied by skac.
  refuses('updated');
  rmSync(file);
  refuses('added');
  assert.ok(!existsSync(out));
});

test('machine export checks an engine reached only through the rig and skips unused engine files', () => {
  const { dir, cfg } = machineProject();
  const out = join(dir, 'app');
  const file = join(dir, 'src', 'motion', 'face.ts');
  write(file, `${readFileSync(file, 'utf8')}export const MINE = 1;\n`);
  assert.equal(run(cfg, out).ok, true);
  write(join(dir, 'src', 'Ball.rig.ts'), `import './rig-helper';\n${RIG}`);
  write(join(dir, 'src', 'rig-helper.ts'), `export * from './motion/face.js';\n`);
  assert.throws(() => run(cfg, out), (e) => e instanceof CliError && /src\/motion\/face\.ts is not current/.test(e.message));
});

test('machine export checks the embedded playback even when the rig bridge is stationary', () => {
  const { dir } = machineProject();
  const machine = JSON.parse(MACHINE);
  machine.layers[1].entry = 'calling';
  machine.values.calling.default = true;
  delete machine.layers[1].states.calling.reason;
  write(join(dir, 'src', 'Ball.machine.json'), JSON.stringify(machine));
  const rig = join(dir, 'src', 'Ball.rig.ts');
  const stationary = `export const meta = { fps: 60, frames: 120, events: [], beats: [] };
export function rig() { 'worklet'; return { channels: { r: 0 } }; }`;
  write(rig, stationary);
  assert.equal(execute(['Ball', '--check'], dir).draft, true);
  write(rig, `${stationary}\n// revised\n`);
  assert.equal(execute(['Ball', '--check'], dir).ok, true);
  const out = join(dir, 'app');
  assert.throws(() => execute(['Ball', '--export', out], dir), (e) => e instanceof CliError
    && e.extra.failures?.some((f) => f.ruleId === 'skac/machine-settles' && f.layer === 'call'));
  assert.ok(!existsSync(out));
});

test('inlined clip imports keep their bindings across local shadows', () => {
  const clips = MCLIPS.replace('import { lift }', 'import { lift as curve }')
    .replace("'worklet'; return { channels: { y: lift(ms) * EASE_OUT(ms / 500), r: 0 } };", `
      'worklet';
      const lift = 7, lift_numbers = 2;
      const local = (curve: number) => ({ curve });
      return { channels: { y: curve(ms), r: lift + lift_numbers + local(3).curve } };`);
  const { dir, cfg } = machineProject({ clips });
  run(cfg, join(dir, 'app'));
  const [{ text }] = buildSync({ stdin: { contents: `${bundleText(dir)}\nexport { clips };`, loader: 'tsx' },
    format: 'cjs', write: false }).outputFiles;
  const module = { exports: {} };
  runInNewContext(text, { module, require: () => ({ forwardRef: (fn) => fn }) });
  const { y, r } = module.exports.clips.bounce.play(250).channels;
  assert.equal(y, -5);
  assert.equal(r, 12);
});

test('machine export checks the worklet directive on quoted play methods and properties', () => {
  for (const play of ["'play'(ms: number) {", "'play': (ms: number) => {"]) {
    const valid = MCLIPS.replace('play(ms: number) {', play);
    const { cfg, dir } = machineProject({ clips: valid });
    const out = join(dir, 'app');
    assert.equal(run(cfg, out).ok, true);
    write(join(dir, 'src', 'Ball.clips.ts'), valid.replace(`${play} 'worklet';`, play));
    assert.throws(() => run(cfg, out), /a clip's play\(\).*does not start with 'worklet'/);
  }
});

const runtimeHarness = (__DEV__) => {
  const [{ text }] = buildSync({ entryPoints: [join(PACKAGE_ROOT, 'runtime', 'index.ts')], bundle: true, write: false,
    format: 'cjs', external: ['react', 'react-native-reanimated', 'react-native-worklets'] }).outputFiles;
  const module = { exports: {} };
  const rn = [];
  const ui = [];
  let index = 0;
  let preparing;
  const hooks = [];
  const dirty = new Set();
  const slot = (init) => {
    const i = index++;
    if (!(i in hooks)) hooks[i] = init();
    return hooks[i];
  };
  const memo = (fn, deps) => {
    const state = slot(() => ({}));
    if (!state.deps || deps.some((dep, i) => !Object.is(state.deps[i], dep))) {
      state.value = fn();
      state.deps = deps;
    }
    return state.value;
  };
  const shared = (value) => {
    const listeners = new Set();
    return {
      get value() { if (preparing) listeners.add(preparing); return value; },
      set value(next) {
        // A shared value captured by a derived worklet is an input even when it only writes that value.
        if (preparing) listeners.add(preparing);
        if (Object.is(value, next)) return;
        value = next;
        for (const run of listeners) dirty.add(run);
      },
    };
  };
  const mapper = (prepare, react) => {
    const state = slot(() => ({ run: () => {
      preparing = state.run;
      const next = state.prepare();
      preparing = undefined;
      state.react(next);
    } }));
    Object.assign(state, { prepare, react });
    dirty.add(state.run);
  };
  const flush = () => {
    for (let pass = 0; dirty.size; pass++) {
      assert.ok(pass < 10, 'the mapper queue must drain');
      const batch = [...dirty];
      dirty.clear();
      for (const run of batch) run();
    }
  };
  let frames;
  const peers = {
    react: { useCallback: (fn, deps) => memo(() => fn, deps), useEffect: memo, useMemo: memo },
    'react-native-reanimated': {
      useAnimatedReaction: mapper,
      useDerivedValue: (prepare) => {
        const out = slot(() => shared(undefined));
        mapper(prepare, (value) => { out.value = value; });
        return out;
      },
      useSharedValue: (value) => slot(() => shared(value)), useReducedMotion: () => false,
      useFrameCallback: (fn, initiallyActive) => {
        frames = slot(() => ({ active: initiallyActive, setActive(value) { this.active = value; } }));
        frames.tick = fn;
        return frames;
      },
    },
    'react-native-worklets': { scheduleOnRN: (fn, ...args) => rn.push(() => fn(...args)), scheduleOnUI: (fn, ...args) => ui.push(() => fn(...args)) },
  };
  runInNewContext(text, { module, require: (id) => peers[id], __DEV__ });
  return {
    ...module.exports, ui, rn, shared, flush,
    useMachine: (...args) => { index = 0; return module.exports.useMachine(...args); },
    observePose: (pose, draw) => mapper(() => pose.value, draw),
    active: () => frames.active,
    frame: (timestamp, dt = null) => {
      assert.equal(frames.active, true);
      frames.tick({ timestamp, timeSincePreviousFrame: dt });
      flush();
    },
  };
};

test('the runtime refuses a newer export only in development and names the version to install', () => {
  const { useMachine, runtimeVersion } = runtimeHarness(true);
  const machine = { schema: 'skac.machine/1', layers: [] };
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(runtimeVersion, pkg.version);
  const next = `${Number(runtimeVersion.split('.')[0]) + 1}.0.0`;
  assert.throws(() => useMachine(machine, {}, { exportedBy: next }), { message: new RegExp(`Install skia-motion-agentic-cli@${next}`) });
  for (const exportedBy of ['0.0.1', runtimeVersion, `${runtimeVersion}+build`]) {
    assert.doesNotThrow(() => useMachine(machine, {}, { exportedBy }));
  }
  assert.doesNotThrow(() => runtimeHarness(false).useMachine(machine, {}, { exportedBy: next }));
});

test('JS writes and trigger fires wake the frame callback after an already queued sleep', () => {
  const machine = {
    schema: 'skac.machine/1', values: { live: { type: 'boolean' }, tap: { type: 'trigger' }, moved: { type: 'boolean', bind: 'out' } },
    layers: [{ name: 'main', entry: 'idle', states: { idle: {}, done: { on_enter: [{ set: 'moved', to: true }] } },
      transitions: [{ from: 'idle', to: 'done', when: [['live', '==', true]] }, { from: 'idle', to: 'done', when: [['tap']] }] }],
  };
  for (const write of [(handle) => handle.set('live', true), (handle) => handle.fire('tap')]) {
    const { useMachine, rn, ui, frame } = runtimeHarness(true);
    const handle = useMachine(machine, {});
    frame(0); // The resting tick queues sleep on RN.
    assert.equal(rn.length, 1);
    assert.throws(() => handle.set('live', 1), /"live" takes a boolean/);
    write(handle);
    assert.equal(ui.length, 1);
    ui.shift()(); // JS write reaches UI while sleep is still queued.
    assert.equal(rn.length, 2);
    rn.shift()(); // Sleep, then wake.
    rn.shift()();
    frame(16); // The first frame after a wake has no previous frame timestamp.
    assert.equal(handle.readOnUI('moved'), true);
  }
});

test('the app scheduler delivers state entries in order, then suspends its frame callback', () => {
  const { useMachine, rn, ui, frame, active } = runtimeHarness(false);
  const machine = {
    schema: 'skac.machine/1',
    values: { tap: { type: 'trigger' } },
    layers: [{ name: 'main', entry: 'idle', states: { idle: {}, reacting: { clip: 'flash' }, done: {} },
      transitions: [
        { from: 'idle', to: 'reacting', when: [['tap']] },
        { from: 'reacting', to: 'done', exit_at: 1 },
      ] }],
  };
  const entries = [];
  const handle = useMachine(machine, { flash: { ms: 10, play: () => ({ channels: {} }) } }, {
    onStateEntries: (batch) => entries.push(...batch),
  });
  const run = (queue) => { while (queue.length) queue.shift()(); };
  frame(0);
  run(rn);
  assert.equal(active(), false);
  assert.equal(entries.length, 0);
  handle.fire('tap');
  run(ui);
  run(rn);
  frame(16);
  frame(48, 32);
  run(rn);
  assert.deepEqual(entries.map(({ state }) => state), ['reacting', 'done']);
  assert.equal(active(), false);
});

test('a settled pose stops rebuilding the picture, including on a shared clock', () => {
  const { useMachine, shared, observePose, flush, frame, active, rn } = runtimeHarness(true);
  const ambient = shared(0);
  const machine = { schema: 'skac.machine/1', clocks: { ambient: { step_hz: 30 } },
    layers: [{ name: 'main', clock: 'ambient', entry: 'idle', states: { idle: { clip: 'fade' } } }] };
  const clips = { fade: { ms: 100, play: (ms) => ({ channels: { x: ms } }) } };
  const clocks = { ambient };
  const handle = useMachine(machine, clips, { clocks });
  const pictures = [];
  observePose(handle.pose, (p) => pictures.push(p.channels.x));
  frame(0);
  rn.shift()();
  assert.equal(active(), false);
  for (const ms of [50, 100, 150, 200]) { ambient.value = ms; flush(); }
  assert.deepEqual(pictures, [0, 50, 100]);
  useMachine(machine, clips, { clocks, live: false });
  ambient.value = 250;
  flush();
  assert.deepEqual(pictures, [0, 50, 100]);
});

test('disabling reduced motion wakes a sleeping frame-clock loop', () => {
  const { useMachine, frame, active, rn } = runtimeHarness(true);
  const machine = { schema: 'skac.machine/1',
    layers: [{ name: 'main', entry: 'idle', states: { idle: { clip: 'pulse', loop: 'loop' } } }] };
  const clips = { pulse: { ms: 100, play: (ms) => ({ channels: { x: ms } }) } };
  useMachine(machine, clips, { reduced: true });
  frame(0);
  rn.shift()();
  assert.equal(active(), false);
  const handle = useMachine(machine, clips, { reduced: false });
  assert.equal(active(), true);
  frame(16);
  frame(32, 16);
  assert.equal(handle.pose.value.channels.x, 16);
});

test('a helper named index can be inlined in the single export', () => {
  const { dir, cfg } = machineProject({ clips: MCLIPS.replace("import { lift } from './numbers';", "import { lift } from './shapes/index';") });
  write(join(dir, 'src', 'shapes', 'index.ts'), `export function lift(ms: number) { 'worklet'; return -ms / 50; }\n`);
  run(cfg, join(dir, 'app'));
  assert.match(bundleText(dir), /function lift\(ms: number\) \{ 'worklet'; return -ms \/ 50; \}/);
});

test('machine export refuses reserved declarations in clips and helpers', () => {
  for (const [source, name, declaration] of [
    ['Ball.clips.ts', 'machine', 'const machine = {};'],
    ['numbers.ts', 'exportedBy', 'const { exportedBy } = { exportedBy: "old" };'],
  ]) {
    const { dir, cfg } = machineProject();
    const file = join(dir, 'src', source);
    write(file, `${readFileSync(file, 'utf8')}\n${declaration}\n`);
    assert.throws(() => run(cfg, join(dir, 'app')), (e) => e instanceof CliError && e.message === `${source} declares the reserved name ${name}`);
    assert.ok(!existsSync(join(dir, 'app')));
  }
});

test('helpers can re-export named runtime bindings while their code stays external', () => {
  const { dir, cfg } = machineProject({ clips: MCLIPS.replace("from './motion/motion'", "from './curve'") });
  write(join(dir, 'src', 'curve.ts'), `export { CUBIC_OUT as EASE_OUT } from './motion/motion';\n`);
  run(cfg, join(dir, 'app'));
  const text = bundleText(dir);
  assert.match(text, /CUBIC_OUT as EASE_OUT.*from 'skia-motion-agentic-cli\/runtime'/);
  assert.doesNotMatch(text, /function CUBIC_OUT|from '\.\/curve'/);
});

test('an inlined machine library keeps its notice and its generated-code directive', () => {
  const { dir, cfg } = machineProject({ clips: MCLIPS.replace("'./numbers'", "'./motion/lib/local.worklet'") });
  write(join(dir, 'src', 'motion', 'lib', 'local.worklet.ts'),
    "// Required Notice: Copyright (c) Someone\n// @ts-nocheck\n\nexport function lift(ms) { 'worklet'; return ms; }\n");
  run(cfg, join(dir, 'app'));
  const text = bundleText(dir);
  assert.equal(text.split('\n')[1], '// @ts-nocheck');
  assert.ok(text.indexOf('// Required Notice: Copyright (c) Someone') < text.indexOf('function lift'));
  assert.match(text, /function lift\(ms\) \{ 'worklet'; return ms; \}/);
});

test('a machine scene with the default config targets react-native-skia v3', () => {
  const { dir, cfg } = machineProject();
  run(cfg, join(dir, 'app'));
  assert.match(bundleText(dir), /from 'react-native-skia'/);
});

test('a machine export rewrites Skia imports to the config-relative wrapper and reports the configured spelling', () => {
  const skia = './design-system/skia';
  const { dir } = machineProject({ config: { app: { skia } } });
  const wrapper = join(dir, 'design-system', 'skia.ts');
  write(wrapper, `export * from 'react-native-skia';\n`);
  const helper = join(dir, 'src', 'numbers.ts');
  write(helper, `import type { SkPaint } from "react-native-skia";\n${readFileSync(helper, 'utf8').replace('ms: number', 'ms: number, paint?: SkPaint')}`);
  const out = join(dir, 'app');
  const r = run(loadConfig(join(dir, 'src')), out);
  const text = bundleText(dir);
  const imports = text.match(/^import .* from '\.\.\/design-system\/skia';$/gm);
  assert.equal(imports.length, 1);
  for (const name of ['Canvas', 'type SkCanvas', 'type SkPaint']) assert.ok(imports[0].includes(name));
  assert.doesNotMatch(text, /react-native-skia/);
  assert.ok(r.needs.includes(`${skia} (Skia >=3.0.0)`));
});

test('a wrapper export checks Skia from the wrapper directory', () => {
  const { dir, cfg } = machineProject({ config: { app: { skia: './design-system/skia' } } });
  const wrapperDir = join(dir, 'design-system');
  write(join(wrapperDir, 'skia.ts'), `export * from 'react-native-skia';\n`);
  const app = tmp('app-');
  const out = join(app, 'src');
  const name = 'react-native-skia';
  const install = (base, version) => write(join(base, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  install(app, '3.10.2');
  install(wrapperDir, '0.0.1');
  assert.throws(() => run(cfg, out), /react-native-skia.*0\.0\.1.*>=3\.0\.0/);
  install(wrapperDir, '3.10.2');
  install(app, '0.0.1');
  assert.equal(run(cfg, out).ok, true);
  assert.match(readFileSync(join(out, 'Ball.tsx'), 'utf8'), /from '\.\.\/.*\/design-system\/skia'/);
});

test('a symlinked Skia wrapper checks dependencies from its real path', () => {
  const { dir, cfg } = machineProject({ config: { app: { skia: './design-system/skia' } } });
  const linkDir = join(dir, 'design-system');
  const realDir = join(tmp(), 'shared');
  const wrapper = join(realDir, 'skia.ts');
  const name = 'react-native-skia';
  const installed = join(realDir, 'node_modules', name, 'package.json');
  write(wrapper, `export * from '${name}';\n`);
  write(join(linkDir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '3.10.2' }));
  symlinkSync(wrapper, join(linkDir, 'skia.ts'));

  const out = join(dir, 'app');
  write(installed, JSON.stringify({ name, version: '0.0.1' }));
  assert.throws(() => run(cfg, out), /react-native-skia.*0\.0\.1.*>=3\.0\.0/);
  write(installed, JSON.stringify({ name, version: '3.10.2' }));
  assert.equal(run(cfg, out).ok, true);
  assert.match(bundleText(dir), /from '\.\.\/design-system\/skia'/);
});

test('a wrapper without a direct Skia import is exported with a warning', () => {
  const skia = './design-system/skia';
  for (const makeProject of [project, machineProject]) {
    const { dir } = makeProject();
    write(join(dir, 'skia-motion.json'), JSON.stringify({ app: { skia } }));
    write(join(dir, 'design-system', 'skia.ts'), `export * from './barrel';\n`);
    write(join(dir, 'design-system', 'barrel.ts'), `export * from 'react-native-skia';\n`);
    const out = join(dir, 'app');
    const cfg = loadConfig(dir);
    const doc = run(cfg, out);
    assert.equal(doc.ok, true);
    assert.deepEqual(doc.warnings, [`Skia version not verified for wrapper ${skia}`]);
    assert.ok(doc.needs.includes(skia));
    assert.match(bundleText(dir), /from '\.\.\/design-system\/skia'/);

    write(join(dir, 'package.json'), JSON.stringify({ dependencies: {
      '@shopify/react-native-skia': '2.5.5', 'react-native-skia': '0.0.1',
    } }));
    assert.deepEqual(run(cfg, out).warnings, doc.warnings);
  }
});

test('machine export refuses a missing Skia wrapper with the resolved path in the error', () => {
  const { dir, cfg } = machineProject({ config: { app: { skia: './missing/skia.ts' } } });
  const out = join(dir, 'app');
  assert.throws(() => run(cfg, out), (e) => e instanceof CliError && e.message === `app.skia path ${join(dir, 'missing', 'skia.ts')} does not exist as a module file`);
  assert.ok(!existsSync(out));
});

test('a machine scene is refused when a clip is not a worklet or the machine has a problem', () => {
  const noWorklet = machineProject({ clips: MCLIPS.replace("play(ms: number) { 'worklet'; return { channels: { r: ms / 2000 } }; }", 'play(ms: number) { return { channels: { r: ms / 2000 } }; }') });
  assert.throws(() => run(noWorklet.cfg, join(noWorklet.dir, 'app')), (e) => e instanceof CliError && /play\(\) in Ball\.clips\.ts does not start with 'worklet'/.test(e.message));
  const bad = machineProject();
  write(join(bad.dir, 'src', 'Ball.machine.json'), MACHINE.replace('"clip": "bounce"', '"clip": "hop"'));
  assert.throws(() => run(bad.cfg, join(bad.dir, 'app')), (e) => e instanceof CliError && /does not pass --machine/.test(e.message) && e.extra.problems.length === 1);
});
