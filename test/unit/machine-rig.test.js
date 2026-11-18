import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../../src/cli.js';
import { tmp, write } from './helpers.js';

// A machine scene end to end through the CLI: the machine JSON, its clips, and the rig file that bridges them, the way
// `skac docs machine` shows. Every existing command reads the bridged rig unchanged.
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const FIXTURE = readFileSync(join(ROOT, 'test', 'fixtures', 'machines', 'invite.machine.json'), 'utf8');
const CLIPS = `export const clips = {
  rest: { ms: 1, play(ms: number) { 'worklet'; return { channels: { y: 0 }, parts: { button: { x: 60, y: 60, w: 80, h: 80 } } }; } },
  bounce: { ms: 500, play(ms: number) { 'worklet'; const y = -10 * Math.sin((Math.PI * ms) / 500); return { channels: { y }, parts: { button: { x: 60, y: 60 + y, w: 80, h: 80 } } }; } },
  call: { ms: 64000 / 24, play(ms: number) { 'worklet'; return { channels: { r: 1 + ms / 1000 } }; } },
  still: { ms: 1, play(ms: number) { 'worklet'; return { channels: { r: 0 } }; } },
};
`;
const RIG = (settle = '') => `import machine from './Invite.machine.json';
import { clips } from './Invite.clips';
import { machineRig, type Machine, type MachineEvent } from './motion/machine';
export const meta = { fps: 60, frames: 180, width: 200, height: 200, scale: 1, events: [{ name: 'live', to: true, at: 0.3 }] as MachineEvent[], beats: []${settle} };
export const rig = machineRig(machine as Machine, clips, meta.events);
`;

const project = ({ machine = FIXTURE, settle } = {}) => {
  const dir = tmp();
  write(join(dir, 'skia-motion.json'), JSON.stringify({ entry: 'src/index.ts', root: 'src/Root.tsx', out: 'out' }));
  write(join(dir, 'src', 'Root.tsx'), `import { Composition } from 'remotion';
import { Invite } from './Invite';
export const Root = () => <>
  <Composition id="Invite" component={Invite} width={200} height={200} fps={60} durationInFrames={180} />
</>;
`);
  write(join(dir, 'src', 'Invite.tsx'), 'export const Invite = () => null;\n');
  write(join(dir, 'src', 'Invite.machine.json'), machine);
  write(join(dir, 'src', 'Invite.clips.ts'), CLIPS);
  write(join(dir, 'src', 'Invite.rig.ts'), RIG(settle === undefined ? '' : `, settle_ms: ${settle}`));
  for (const f of ['motion.ts', 'machine.ts']) write(join(dir, 'src', 'motion', f), readFileSync(join(ROOT, 'templates', 'motion', f), 'utf8'));
  return dir;
};
const run = (dir, ...argv) => execute(['Invite', ...argv], dir);
// The draft gate answers a scene's first --check, and any re-run of it unchanged, as a draft. A second check after a
// change of the scene's files (here a comment in the rig) gives the real verdict.
const checked = (dir, ...argv) => {
  const first = run(dir, '--check', ...argv);
  assert.equal(first.draft, true);
  write(join(dir, 'src', 'Invite.rig.ts'), `${readFileSync(join(dir, 'src', 'Invite.rig.ts'), 'utf8')}// revised\n`);
  return run(dir, '--check', ...argv);
};

test('--machine checks the clip names the clips file exports', () => {
  const doc = run(project(), '--machine');
  assert.equal(doc.ok, true, JSON.stringify(doc.problems));
  assert.equal(doc.clips_checked, true);
  const broken = project({ machine: FIXTURE.replace('"clip": "bounce"', '"clip": "hop"') });
  assert.match(run(broken, '--machine').problems[0].error, /no clip named "hop"/);
});

test('--check passes the invite: it settles after the bounce, and the replay is deterministic', () => {
  const doc = checked(project());
  assert.equal(doc.ok, true, JSON.stringify(doc.failures));
  assert.deepEqual(doc.warnings.filter((w) => w.ruleId === 'skac/determinism'), []);
});

test('--check works with a missing app.skia wrapper path in the config', () => {
  const dir = project();
  const path = join(dir, 'skia-motion.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  write(path, JSON.stringify({ ...config, app: { skia: './missing/skia.ts' } }));
  assert.equal(checked(dir).ok, true);
});

test('--trace gives each layer\'s state, the values and what keeps it drawing', () => {
  const doc = run(project(), '--trace=100,300,800,1300');
  assert.equal(doc.ok, true);
  assert.deepEqual(doc.trace.map((r) => r.states.enter), ['hidden', 'bounce', 'shown', 'shown']);
  assert.deepEqual(doc.trace.map((r) => r.values.bounced), [false, false, true, true]);
  assert.deepEqual(doc.trace.map((r) => r.awake.length > 0), [false, true, true, false]);
  assert.equal(run(project(), '--trace=every:500').trace.length, 7);
});

test('--commands writes values and taps a part box: the tap restarts the bounce through its hit area', () => {
  const doc = run(project(), '--trace=1600', '--commands', 'live=true@0.3 tap:100,100@1.5');
  assert.equal(doc.trace[0].states.enter, 'bounce');
  const miss = run(project(), '--trace=1600', '--commands', 'live=true@0.3 tap:5,5@1.5');
  assert.equal(miss.trace[0].states.enter, 'shown');
});

test('--commands preserves quoted boolean-like and numeric enum options in both formats', () => {
  const machine = JSON.parse(FIXTURE);
  machine.values.mood.options.push('true', '001');
  const dir = project({ machine: JSON.stringify(machine) });
  const file = join(dir, 'mood.txt');
  write(file, 'set mood "true" 0.1\nset mood "001" 0.2\n');
  for (const commands of [file, 'mood="true"@0.1 mood="001"@0.2']) {
    const { trace } = run(dir, '--trace=100,200', '--commands', commands);
    assert.deepEqual(trace.map((row) => row.values.mood), ['true', '001']);
  }
});

test('skac/machine-settles: a loop with no reason fails, a reason excuses it, a late rest fails its limit', () => {
  const noReason = project({ machine: FIXTURE.replace(', "reason": "asks for a tap until the screen is covered"', '') });
  const failing = checked(noReason, '--commands', 'live=true@0.3 calling=true@1');
  const f = failing.failures.find((x) => x.ruleId === 'skac/machine-settles');
  assert.match(f.message, /still drawing at the end .* layer `call` never rests/);
  assert.equal(checked(project(), '--commands', 'live=true@0.3 calling=true@1').ok, true);
  const late = checked(project({ settle: 500 }));
  assert.match(late.failures.find((x) => x.ruleId === 'skac/machine-settles').message, /rests at 1\.3 s, 1 s after its last write \(limit 0\.5 s\)/);
});

test('skac/machine-settles catches a once clip that replays after a wrap beyond the check window', () => {
  const machine = JSON.parse(FIXTURE);
  const motion = CLIPS.replace('still: { ms: 1, play(ms: number) { \'worklet\'; return { channels: { r: 0 } }; } }',
    'still: { ms: 200, play(ms: number) { \'worklet\'; return { channels: { r: ms * (200 - ms) / 10000 } }; } }');
  const check = () => {
    const dir = project({ machine: JSON.stringify(machine) });
    write(join(dir, 'src', 'Invite.clips.ts'), motion);
    return checked(dir);
  };
  assert.ok(check().failures.some((f) => f.ruleId === 'skac/machine-settles' && f.layer === 'call'));
  machine.layers[1].states.quiet.reason = 'a periodic reminder';
  assert.equal(check().ok, true);
  delete machine.layers[1].states.quiet.reason;
  machine.layers[1].states.quiet = { blend: { by: 'level', keys: [[0, 'rest'], [1, 'still']] } };
  assert.equal(check().ok, true);
  machine.values.level.default = 1;
  assert.ok(check().failures.some((f) => f.ruleId === 'skac/machine-settles' && f.layer === 'call'));
  delete machine.clocks.ambient.wrap_ms;
  assert.equal(check().ok, true);
});

// Codex review of M1 (18 Nov): each failed on the code it reviewed.
const outcome = (fn) => { try { return fn(); } catch (e) { return { ok: false, error: e.message }; } };

test('--trace refuses a step of 0 or one that would give a huge grid, before building it', () => {
  assert.match(outcome(() => run(project(), '--trace=every:0')).error, /needs a step above 0/);
  assert.match(outcome(() => run(project(), '--trace=every:0.001')).error, /over 2000 rows/);
});

test('an event that does not fit its value is refused with the event named', () => {
  const r = outcome(() => run(project(), '--trace=500', '--commands', 'live=true@0.3 level=bad@0.4'));
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /level=bad@0.4: \\?"level\\?" takes a number/);
});
