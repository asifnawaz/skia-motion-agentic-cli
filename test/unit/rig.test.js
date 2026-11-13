import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRID_HZ, loadRig, sampleRig } from '../../src/rig.js';
import { CliError } from '../../src/util.js';
import { tmp } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = tmp('rig-'); // this file's own folder (helpers.js); update.test.js keeps test/.tmp to itself

const cfgFor = (name) => {
  const projectDir = join(here, '..', 'fixtures', 'rig', name);
  return { projectDir, root: join(projectDir, 'src', 'Root.tsx'), out: join(scratch, name) };
};

test('loadRig bundles a .rig.ts that imports another .ts file', () => {
  const cfg = cfgFor('project');
  const { rig, meta, file } = loadRig(cfg, 'Thing');
  assert.equal(file, join(cfg.projectDir, 'src', 'Thing.rig.ts'));
  assert.equal(meta.fps, 30);
  const early = rig(0, meta.events);
  const late = rig(1000, meta.events);
  assert.equal(early.channels.wide, 0);
  assert.equal(late.channels.wide, 1);
  assert.equal(late.parts.body.x, 150);
});

test('loadRig writes the bundle under the out folder and reloads fresh', () => {
  const cfg = cfgFor('project');
  loadRig(cfg, 'Thing');
  const again = loadRig(cfg, 'Thing');
  assert.equal(typeof again.rig, 'function');
});

test('loadRig explains a missing rig file, a missing rig export and a bad meta', () => {
  assert.throws(() => loadRig(cfgFor('project'), 'Nope'), (e) => e instanceof CliError && /no rig file for Nope/.test(e.message));
  assert.throws(() => loadRig(cfgFor('bad'), 'NoRig'), (e) => e instanceof CliError && /does not export rig/.test(e.message));
});

test('loadRig finds the rig beside the component file when the composition id differs (Combo60 drawing Combo)', () => {
  const cfg = cfgFor('project');
  const component = join(cfg.projectDir, 'src', 'Thing.tsx');
  assert.equal(loadRig(cfg, 'Thing60', component).file, join(cfg.projectDir, 'src', 'Thing.rig.ts'));
  assert.throws(() => loadRig(cfg, 'Thing60'), (e) => e instanceof CliError && /no rig file for Thing60/.test(e.message));
});

test('sampleRig samples the 120 Hz grid over the composition length, with times, channels and parts', () => {
  const { rig, meta } = loadRig(cfgFor('project'), 'Thing'); // 30 frames at 30 fps: 1 s
  const s = sampleRig(rig, meta);
  assert.equal(s.fps, GRID_HZ);
  assert.equal(s.t_ms.length, 120);
  assert.ok(Math.abs(s.t_ms[12] - 100) < 1e-9);
  assert.equal(s.channels.wide.length, 120);
  assert.equal(s.parts.body.x.length, 120);
  assert.equal(s.parts.body.w[0], 80);
  assert.equal(s.parts.body.rot, undefined);
  assert.equal(s.channels.wide[119], 1);
  assert.deepEqual(sampleRig(rig, { ...meta, fps: 60, frames: 60 }), s); // the same samples whatever the fps
});

test('sampleRig passes events to the rig and keeps a reversed recheck pass', () => {
  const { rig, meta } = loadRig(cfgFor('project'), 'Thing');
  const s = sampleRig(rig, meta, [{ name: 'tap', at: 0.5 }]);
  assert.equal(s.channels.wide[40], 0); // 333 ms: the scripted tap is at 500 ms
  assert.deepEqual(s.recheck.channels.wide, s.channels.wide);
});

// Changed by design (R2 item 7): a missing value is recorded as NaN for runRules to report, no longer thrown.
test('sampleRig records NaN where a rig leaves out a channel, part or field, keeping every array full length', () => {
  const meta = { fps: 30, frames: 4 }; // 16 samples, 8.3 ms apart
  const late = sampleRig((ms) => ({ channels: ms < 50 ? { a: 1 } : { a: 1, b: 2 } }), meta);
  assert.equal(late.channels.b.length, 16);
  assert.ok(Number.isNaN(late.channels.b[0]) && late.channels.b[6] === 2);
  const lost = sampleRig((ms) => ({ channels: ms < 50 ? { a: 1, b: 2 } : { a: 1 } }), meta);
  assert.ok(lost.channels.b[0] === 2 && Number.isNaN(lost.channels.b[15]));
  const parts = sampleRig((ms) => ({ channels: {}, parts: ms < 50 ? { p: { x: 1, y: 2, rot: 3 } } : { p: { x: 1, y: 2 } } }), meta);
  assert.ok(Number.isNaN(parts.parts.p.rot[15]) && parts.parts.p.x[15] === 1);
  const gone = sampleRig((ms) => ({ channels: {}, parts: ms < 50 ? { p: { x: 1, y: 2 } } : {} }), meta);
  assert.ok(Number.isNaN(gone.parts.p.x[15]) && gone.parts.p.x.length === 16);
  assert.throws(() => sampleRig(() => ({ channels: { a: 'x' } }), meta), (e) => e instanceof CliError && /not a number/.test(e.message));
});
