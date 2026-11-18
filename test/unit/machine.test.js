import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execute } from '../../src/cli.js';
import { loadConfig } from '../../src/config.js';
import { machineCommand, validateMachine } from '../../src/machine.js';
import { tmp, write } from './helpers.js';

const FIXTURE = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', 'fixtures', 'machines', 'invite.machine.json');
const valid = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const CLIPS = ['rest', 'bounce', 'call', 'still'];
const judge = (m) => validateMachine(m, { clipNames: CLIPS });

test('the invite fixture is valid, and its graph reaches every state', () => {
  const r = judge(valid());
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.graphs.map((g) => g.unreachable), [[], []]);
  assert.deepEqual(r.graphs.map((g) => g.zeroTimeCycles), [[], []]);
});

// Each broken copy names its one problem; the where and a hint come with it.
const broken = {
  'an unknown value': (m) => { m.layers[0].transitions[0].when = [['shown', '==', true]]; },
  'a type mismatch': (m) => { m.layers[0].transitions[0].when = [['live', '==', 1]]; },
  'a set action of the wrong type': (m) => { m.layers[0].states.bounce.on_exit = [{ set: 'bounced', to: 'yes' }]; },
  'an unknown clip': (m) => { m.layers[0].states.hidden.clip = 'nap'; },
  'an unknown clock': (m) => { m.layers[1].clock = 'sun'; },
  'a missing entry': (m) => { delete m.layers[0].entry; },
  'a transition that fires at once': (m) => { delete m.layers[0].transitions[1].exit_at; },
  'an unreachable state': (m) => { m.layers[1].states.asleep = { clip: 'rest' }; m.layers[1].transitions.push({ from: 'asleep', to: 'quiet', when: [['live', '==', true]] }); },
  'a zero-time cycle': (m) => {
    m.layers[1].transitions = [
      { from: 'quiet', to: 'calling', when: [['live', '==', true]] },
      { from: 'calling', to: 'quiet', when: [['level', '>', 0]] },
    ];
  },
  'an unknown key': (m) => { m.layers[0].states.hidden.colour = 'red'; },
};
const expect = {
  'an unknown value': /no value named "shown"/,
  'a type mismatch': /1 is not a boolean/,
  'a set action of the wrong type': /"yes" is not a boolean/,
  'an unknown clip': /no clip named "nap"/,
  'an unknown clock': /no clock named "sun"/,
  'a missing entry': /no entry/,
  'a transition that fires at once': /no condition and no exit_at/,
  'an unreachable state': /"asleep" is never reached/,
  'a zero-time cycle': /can loop with no time passing/,
  'an unknown key': /unknown key "colour"/,
};
for (const [what, breakIt] of Object.entries(broken)) {
  test(`refused: ${what}`, () => {
    const m = valid();
    breakIt(m);
    const r = judge(m);
    assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
    assert.match(r.problems[0].error, expect[what]);
    assert.ok(r.problems[0].hint && r.problems[0].where !== undefined);
  });
}

test('exclusive conditions do not make a zero-time cycle, and a trigger breaks one', () => {
  const m = valid();
  m.layers[1].transitions = [
    { from: 'quiet', to: 'calling', when: [['level', '>=', 1]] },
    { from: 'calling', to: 'quiet', when: [['level', '<', 1]] },
  ];
  assert.deepEqual(judge(m).problems, []);
  m.layers[1].transitions = [
    { from: 'quiet', to: 'calling', when: [['tap']] },
    { from: 'calling', to: 'quiet', when: [['live', '==', true]] },
  ];
  assert.deepEqual(judge(m).problems, []);
});

test('instant cycles keep guards that can change between edges, including at an Any State exit', () => {
  for (const any of [false, true]) {
    const m = valid();
    m.values.ready = { type: 'boolean', default: true };
    const down = [{ set: 'ready', to: false }];
    if (any) m.layers[1].states.quiet.on_exit = down;
    m.layers[1].transitions = [
      { from: any ? '*' : 'quiet', to: 'calling', when: [['ready', '==', true]], ...(any ? {} : { on_start: down }) },
      { from: 'calling', to: 'quiet', when: [['ready', '==', false]], on_end: [{ set: 'ready', to: true }] },
    ];
    const r = judge(m);
    assert.deepEqual(r.problems, []);
    assert.ok(r.warnings.some((w) => /quiet -> calling -> quiet can loop with no time passing/.test(w.error)));
  }
});

test('a dense forward-only graph skips guard comparisons during cycle analysis', () => {
  const m = valid();
  let reads = 0;
  const guard = ['live', '==', true];
  Object.defineProperty(guard, 0, { get() {
    assert.ok(++reads <= 300, 'acyclic edges should only need validation');
    return 'live';
  } });
  const names = Array.from({ length: 22 }, (_, i) => `s${i}`);
  const states = Object.fromEntries(names.map((name) => [name, {}]));
  const transitions = names.flatMap((from, i) => names.slice(i + 1).map((to) => ({ from, to, when: [guard] })));
  m.layers = [{ name: 'forward', entry: names[0], states, transitions }];
  const r = judge(m);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.graphs[0].zeroTimeCycles, []);
});

test('enum assignments require a subset of destination options, and comparisons allow different sets', () => {
  const m = valid();
  m.values.other = { type: 'enum', options: ['calm', 'glad'] };
  m.values.mood.options.push('other-option');
  m.layers[0].states.hidden.on_enter = [{ set: 'mood', to: 'other' }];
  m.layers[0].transitions[0].when.push(['mood', '!=', 'other']);
  assert.deepEqual(judge(m).problems, []);
  m.values.other.options.push('upset');
  const r = judge(m);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].error, /enum "other" can write undeclared options: upset/);
  m.values.mood.options.push('other'); // A matching enum option still takes precedence over a value name.
  assert.deepEqual(judge(m).problems, []);
});

test('malformed enum options keep their validation diagnostic when a guard reads the enum', () => {
  const m = valid();
  m.values.mood.options = { calm: true };
  m.layers[0].transitions[0].when.push(['mood', '==', 'live']);
  m.layers[0].transitions[0].when.push(['mood', '==', 'calm']);
  assert.match(judge(m).problems[0].error, /an enum needs "options", two or more strings/);
});

test('exit_at on a named-clock layer is refused: the app steps that clock', () => {
  const m = valid();
  m.layers[1].transitions[1] = { from: 'calling', to: 'quiet', exit_at: 1 };
  assert.match(judge(m).problems[0].error, /exit_at on a layer that runs on a named clock/);
});

test('--machine warns about clips with periods that do not fit a wrapping clock', () => {
  const dir = tmp();
  const m = valid();
  write(join(dir, 'src', 'Invite.machine.json'), JSON.stringify(m));
  const clipsPath = join(dir, 'src', 'Invite.clips.ts');
  const run = () => execute(['Invite', '--machine'], dir);
  assert.equal(run().clips_checked, false);
  assert.deepEqual(run().warnings, []);

  const setLength = (ms) => write(clipsPath, `export const clips = { ${CLIPS.map((name) =>
    `${name}: { ms: ${name === 'call' ? ms : 1}, play() { return { channels: {} }; } }`).join(', ')} };`);
  setLength(64000 / 24);
  assert.deepEqual(run().warnings, []);
  setLength(64000 + 0.5e-6);
  assert.deepEqual(run().warnings, []);
  setLength(64000 + 2e-6);
  assert.equal(run().ok, true);
  assert.equal(run().warnings[0].where, 'layers.call.states.calling');
  assert.match(run().warnings[0].error, /clip "call".*does not divide ambient\.wrap_ms/);
});

test('pingpong counts both directions and speed adjusts the period of each blend clip', () => {
  const m = valid();
  const state = m.layers[1].states.calling;
  delete state.clip;
  state.blend = { by: 'level', keys: [[0, 'still'], [1, 'call']] };
  state.loop = 'pingpong';
  const clips = { rest: { ms: 1 }, bounce: { ms: 500 }, still: { ms: 16000 }, call: { ms: 64000 } };
  const warnings = () => validateMachine(m, { clips }).warnings;
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0].error, /"call" has a 128000 ms period/);
  state.speed = 2;
  assert.deepEqual(warnings(), []);
  state.speed = 1;
  state.loop = 'once';
  assert.deepEqual(warnings(), []);
  state.loop = 'pingpong';
  delete m.clocks.ambient.wrap_ms;
  assert.deepEqual(warnings(), []);
});

test('a state with no way out is a warning, not a problem', () => {
  const m = valid();
  m.layers[1].transitions = [{ from: 'quiet', to: 'calling', when: [['calling', '==', true]] }];
  const r = judge(m);
  assert.deepEqual(r.problems, []);
  assert.match(r.warnings[0].error, /"calling" has no way out/);
});

test('a newer schema asks for a newer skac', () => {
  const m = valid();
  m.schema = 'skac.machine/2';
  assert.match(judge(m).problems[0].hint, /update skac to read skac\.machine\/2/);
});

test('--machine finds the file in src and reports ok, the values and each layer', () => {
  const dir = tmp();
  write(join(dir, 'skia-motion.json'), JSON.stringify({ root: 'src/Root.tsx', out: 'out' }));
  write(join(dir, 'src', 'Root.tsx'), 'export const Root = () => null;\n');
  write(join(dir, 'src', 'Invite.machine.json'), readFileSync(FIXTURE, 'utf8'));
  const doc = machineCommand(loadConfig(dir), 'Invite');
  assert.equal(doc.ok, true);
  assert.equal(doc.clips_checked, false);
  assert.deepEqual(doc.values.bounced, { type: 'boolean', bind: 'out', default: false });
  assert.deepEqual(doc.layers.map((l) => l.name), ['enter', 'call']);
  assert.deepEqual(doc.layers[0].reachable, ['hidden', 'bounce', 'shown']);
});

// Codex review of M1 (18 Nov): each failed on the code it reviewed.
test('an operand naming a value proves no contradiction, so a cycle through x == y and x == z is refused', () => {
  const m = valid();
  m.values.a = { type: 'number', default: 0 };
  m.values.b = { type: 'number', default: 0 };
  m.layers[1].transitions = [
    { from: 'quiet', to: 'calling', when: [['level', '==', 'a']] },
    { from: 'calling', to: 'quiet', when: [['level', '==', 'b']] },
  ];
  assert.match(judge(m).problems[0]?.error ?? '', /can loop with no time passing/);
});

test('a cycle whose actions write what its conditions read is a warning, not a refusal', () => {
  const m = valid();
  m.layers[1].states.quiet.on_enter = [{ set: 'calling', to: false }];
  m.layers[1].transitions = [
    { from: 'quiet', to: 'calling', when: [['live', '==', true]] },
    { from: 'calling', to: 'quiet', when: [['calling', '==', true]] },
  ];
  const r = judge(m);
  assert.deepEqual(r.problems, []);
  assert.match(r.warnings.map((w) => w.error).join(' '), /depending on actions that write values read by its conditions/);
});

test('down and up hit areas are refused until both runtimes play them', () => {
  const m = valid();
  m.hits[0].on = 'down';
  assert.match(judge(m).problems[0].error, /on "down" is not one of tap/);
});

test('--machine on a file holding null answers with the problem, not a crash', () => {
  const dir = tmp('machine-null-');
  write(join(dir, 'skia-motion.json'), JSON.stringify({ root: 'src/Root.tsx', out: 'out' }));
  write(join(dir, 'src', 'Root.tsx'), 'export const Root = () => null;\n');
  write(join(dir, 'src', 'Nul.machine.json'), 'null');
  let r;
  try { r = machineCommand(loadConfig(dir), 'Nul'); } catch (e) { r = e; }
  assert.match(JSON.stringify(r.details ?? r), /the machine is not a JSON object/);
});
