import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.js';

// templates/motion/machine.ts (the runtime core) through esbuild, as the CLI loads rigs.
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const loadCore = () => {
  const outfile = join(tmp('core-'), 'core.cjs');
  require('esbuild').buildSync({ entryPoints: [join(ROOT, 'templates', 'motion', 'machine.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  return require(outfile);
};
const core = loadCore();
const { compile, start, advance, pose, settled, hitTest, hitWrites, simulatedClock, writeProblem, machineRig } = core;

test('a cut and a mix both run transition end actions after destination entry', () => {
  for (const duration_ms of [0, 1]) {
    const machine = { schema: 'skac.machine/1', values: { ready: { type: 'boolean', bind: 'out' }, tap: { type: 'trigger' } },
      layers: [{ name: 'main', entry: 'idle', states: { idle: {}, done: { on_enter: [{ set: 'ready', to: false }] } },
        transitions: [{ from: 'idle', to: 'done', when: [['tap']], duration_ms, on_end: [{ set: 'ready', to: true }] }] }] };
    const rig = machineRig(machine, {});
    const events = [{ name: 'tap', at: 0 }];
    assert.equal(rig.inspect(0, events).values.ready, duration_ms === 0);
    assert.equal(rig.inspect(1, events).values.ready, true);
  }
});

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'machines', 'invite.machine.json'), 'utf8'));
const CLIPS = {
  rest: { ms: 1, play: () => ({ channels: { y: 0, r: 0 }, parts: { button: { x: 0, y: 0, w: 80, h: 80 } } }) },
  bounce: { ms: 500, play: (ms) => ({ channels: { y: -10 * Math.sin((Math.PI * ms) / 500), r: 0 }, parts: { button: { x: 0, y: -ms / 50, w: 80, h: 80 } } }) },
  call: { ms: 64000 / 24, play: (ms) => ({ channels: { r: 1 + ms / 1000 } }) },
  still: { ms: 1, play: () => ({ channels: { r: 0 } }) },
};
const machine = (edit) => { const m = structuredClone(FIXTURE); if (edit) edit(m); return m; };
const setup = (m = machine()) => ({ m, c: compile(m, CLIPS), clock: simulatedClock(m) });

// A deterministic random source, so a failure names its seed.
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const randomLog = (r, ms) => {
  const writes = [];
  for (let i = 0, n = 3 + Math.floor(r() * 25); i < n; i++) {
    const at = Math.round(r() * ms * 4) / 4;
    const pick = r();
    if (pick < 0.3) writes.push({ at, value: 'live', to: r() < 0.7 });
    else if (pick < 0.55) writes.push({ at, value: 'calling', to: r() < 0.6 });
    else if (pick < 0.75) writes.push({ at, value: 'level', to: Math.round(r() * 100) / 100 });
    else if (pick < 0.9) writes.push({ at, value: 'tap', to: true });
    else writes.push({ at, value: 'mood', to: r() < 0.5 ? 'calm' : 'glad' });
  }
  return writes;
};

test('advance splits: frame by frame equals the whole run, at every frame, for 500 random logs', () => {
  const { c, clock } = setup();
  const LEN = 6000;
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed);
    const writes = randomLog(r, LEN);
    let s = start(c);
    for (let t = 0; t <= LEN; t += 8 + Math.floor(r() * 26)) {
      s = advance(c, s, t, writes, clock);
      if (t % 7 !== 0 && t + 34 <= LEN) continue; // the whole run is replayed at about one frame in seven, and at the end
      const whole = advance(c, start(c), t, writes, clock);
      assert.deepEqual(s, whole, `seed ${seed} at ${t} ms`);
      assert.deepEqual(pose(c, CLIPS, s, t, clock), pose(c, CLIPS, whole, t, clock), `seed ${seed} pose at ${t} ms`);
    }
  }
});

const stateOf = (c, s, layer) => {
  const li = c.layers.findIndex((L) => L.name === layer);
  const l = s.layers[li];
  return l.s === -2 ? 'exit' : l.s < 0 ? null : c.layers[li].states[l.s].name;
};

test('entry, a bounce on live, its exit time at 1 with a mix, and an action that sets an out-value', () => {
  const { c, clock } = setup();
  const writes = [{ at: 300, value: 'live', to: true }];
  const at = (t) => advance(c, start(c), t, writes, clock);
  assert.equal(stateOf(c, at(0), 'enter'), 'hidden');
  assert.equal(stateOf(c, at(300), 'enter'), 'bounce');
  assert.equal(stateOf(c, at(799.9), 'enter'), 'bounce');
  const s = at(800);
  assert.equal(stateOf(c, s, 'enter'), 'shown');
  assert.equal(s.vals[c.index.bounced], true); // on_exit of bounce
  // The mix runs 120 ms: at its start the pose is the bounce's end, at its end the blend's (level 0: rest).
  assert.equal(pose(c, CLIPS, s, 800, clock).channels.y, CLIPS.bounce.play(500).channels.y);
  assert.equal(pose(c, CLIPS, at(920), 920, clock).channels.y, 0);
});

test('the Any State goes first, and a trigger lasts one instant and is taken once per layer', () => {
  const { c, clock } = setup();
  // live off and tap at the same instant: Any (to hidden) wins over shown -> bounce.
  const writes = [{ at: 0, value: 'live', to: true }, { at: 2000, value: 'tap', to: true }, { at: 2000, value: 'live', to: false }];
  const s = advance(c, start(c), 2000, writes, clock);
  assert.equal(stateOf(c, s, 'enter'), 'hidden');
  assert.equal(s.vals[c.index.tap], false);
  // A tap alone restarts the bounce from shown, once.
  const s2 = advance(c, start(c), 2000, [{ at: 0, value: 'live', to: true }, { at: 2000, value: 'tap', to: true }], clock);
  assert.equal(stateOf(c, s2, 'enter'), 'bounce');
  assert.equal(s2.layers[0].at, 2000);
});

test('a layer stops at 100 changes in one instant', () => {
  const { c, clock } = setup(machine((m) => {
    m.layers[1].transitions = [
      { from: 'quiet', to: 'calling', when: [['live', '==', true]] },
      { from: 'calling', to: 'quiet', when: [['live', '==', true]] },
    ];
  }));
  const s = advance(c, start(c), 10, [{ at: 5, value: 'live', to: true }], clock);
  assert.equal(stateOf(c, s, 'call'), 'quiet'); // 100 changes: an even count, back where it began
});

test('a named clock steps at its rate and wraps at its length, and the layer reads time since its entry on it', () => {
  const { m, c, clock } = setup();
  assert.equal(clock('ambient', 1000 / 30 - 0.001), 0);
  assert.equal(clock('ambient', 1000 / 30), 1000 / 30);
  assert.equal(clock('ambient', 64000), 0);
  const writes = [{ at: 0, value: 'live', to: true }, { at: 1000, value: 'calling', to: true }];
  const enteredAt = clock('ambient', 1000);
  for (const t of [1000, 1500, 30000, 63999, 64000, 64050, 70000]) {
    const s = advance(c, start(c), t, writes, clock);
    const since = (((clock('ambient', t) - enteredAt) % 64000) + 64000) % 64000;
    assert.equal(pose(c, CLIPS, s, t, clock).channels.r, CLIPS.call.play(since % CLIPS.call.ms).channels.r, `at ${t}`);
  }
  assert.equal(m.clocks.ambient.wrap_ms, 64000);
});

test('a 1D blend at, between and outside its keys', () => {
  const lin = { a: { ms: 1, play: () => ({ channels: { v: 10 } }) }, b: { ms: 1, play: () => ({ channels: { v: 30 } }) } };
  const m = { schema: 'skac.machine/1', values: { k: { type: 'number', default: 0 } },
    layers: [{ name: 'L', entry: 'b', states: { b: { blend: { by: 'k', keys: [[0, 'a'], [2, 'b']] } } } }] };
  const c = compile(m, lin);
  const clock = simulatedClock(m);
  const v = (k) => pose(c, lin, advance(c, start(c), 1, [{ at: 0, value: 'k', to: k }], clock), 1, clock).channels.v;
  assert.equal(v(-1), 10);
  assert.equal(v(0), 10);
  assert.equal(v(0.5), 15);
  assert.equal(v(2), 30);
  assert.equal(v(9), 30);
});

test('settled: awake while the bounce plays, settled after it, and the calling loop follows its clock', () => {
  const { c, clock } = setup();
  const writes = [{ at: 300, value: 'live', to: true }];
  const at = (t) => advance(c, start(c), t, writes, clock);
  assert.equal(settled(c, at(500), clock).frame, false);
  // shown is a once-blend whose longest clip (bounce, 500 ms) plays from its entry at 800 ms, so it rests from 1300 ms.
  assert.deepEqual(settled(c, at(1299), clock).awake, ['enter']);
  assert.deepEqual(settled(c, at(1300), clock).awake, []);
  assert.equal(settled(c, at(1300), clock).frame, true);
  const calling = advance(c, start(c), 5000, [...writes, { at: 1000, value: 'calling', to: true }], clock);
  assert.deepEqual(settled(c, calling, clock).clocked, ['call']);
  // Reduced motion: the bounce shows its end at once, but the machine's logic keeps time: it stays awake until the
  // bounce's exit time (800 ms) and its 120 ms mix (whose end may run actions) have passed, then rests at once.
  assert.equal(settled(c, at(400), clock, true).frame, false);
  assert.equal(settled(c, at(919), clock, true).frame, false);
  assert.equal(settled(c, at(920), clock, true).frame, true);
  assert.equal(pose(c, CLIPS, at(400), 400, clock, true).channels.y, CLIPS.bounce.play(500).channels.y);
});

test('hitTest finds a rotated part box, and a hit fires its trigger', () => {
  const { c } = setup();
  const p = { channels: {}, parts: { button: { x: 0, y: 0, w: 100, h: 20, rot: Math.PI / 2 } } };
  assert.equal(hitTest(c, p, 50, 50), 'button'); // the centre
  assert.equal(hitTest(c, p, 50, 5), 'button'); // inside once turned upright
  assert.equal(hitTest(c, p, 95, 10), ''); // inside the unturned box, outside the turned one
  assert.deepEqual(hitWrites(c, 'button', 12, []), [{ at: 12, value: 'tap', to: true, hit: true }]);
});

test('compile refuses a schema it cannot read', () => {
  assert.throws(() => compile({ ...FIXTURE, schema: 'skac.machine/2' }, CLIPS), /reads skac\.machine\/1/);
});

test('every function in the machine core is a worklet, machineRig included (it runs on the JS thread, but engine exports are worklets)', () => {
  const src = readFileSync(join(ROOT, 'templates', 'motion', 'machine.ts'), 'utf8');
  const fns = [...src.matchAll(/^(?:export )?function (\w+)\([^]*?\{\n(.*)\n/gm)].map((m) => [m[1], m[2].trim()]);
  assert.ok(fns.length >= 20, `found ${fns.length} functions`);
  for (const [name, first] of fns) {
    assert.equal(first, "'worklet';", `${name}() does not start with 'worklet'`);
  }
});

// Codex review of M1 (18 Nov): each test below failed on the code it reviewed.

test('a mix on a named-clock layer keeps the frame callback awake until it ends, since mixes run on machine time', () => {
  const { c, clock } = setup(machine((m) => { m.layers[1].transitions[0].duration_ms = 300; }));
  const writes = [{ at: 0, value: 'live', to: true }, { at: 1000, value: 'calling', to: true }];
  // The enter layer has settled by 2000 ms; only the call layer's mix (2000 to 2300) is left.
  const w = [...writes.slice(0, 1), { at: 2000, value: 'calling', to: true }];
  assert.deepEqual(settled(c, advance(c, start(c), 2100, w, clock), clock).awake, ['call']);
  assert.deepEqual(settled(c, advance(c, start(c), 2400, w, clock), clock).awake, []);
});

test('an exited layer holds its blend at the input it had when it exited', () => {
  const lin = { a: { ms: 1, play: () => ({ channels: { v: 10 } }) }, b: { ms: 1, play: () => ({ channels: { v: 30 } }) } };
  const m = { schema: 'skac.machine/1', values: { k: { type: 'number', default: 1 }, go: { type: 'trigger' } },
    layers: [{ name: 'L', entry: 'b', states: { b: { blend: { by: 'k', keys: [[0, 'a'], [2, 'b']] } } },
      transitions: [{ from: 'b', to: 'exit', when: [['go']] }] }] };
  const c = compile(m, lin);
  const clock = simulatedClock(m);
  const s = advance(c, start(c), 30, [{ at: 10, value: 'go', to: true }, { at: 20, value: 'k', to: 2 }], clock);
  assert.equal(pose(c, lin, s, 30, clock).channels.v, 20);
});

test('outside writes must fit the value: no out-values, a number for a number, an option for an enum, true for a trigger', () => {
  const { c, m, clock } = setup();
  assert.equal(writeProblem(c, 'live', true), '');
  assert.equal(writeProblem(c, 'mood', 'glad'), '');
  assert.equal(writeProblem(c, 'tap', true), '');
  assert.match(writeProblem(c, 'bounced', true), /out-value/);
  assert.match(writeProblem(c, 'level', 'bad'), /takes a number/);
  assert.match(writeProblem(c, 'level', true), /takes a number/);
  assert.match(writeProblem(c, 'mood', 'cross'), /one of calm, glad/);
  assert.match(writeProblem(c, 'nope', 1), /no value "nope"/);
  // The core drops one that reaches it; the rig refuses it with the event in the message.
  const s = advance(c, start(c), 10, [{ at: 5, value: 'level', to: 'bad' }], clock);
  assert.equal(s.vals[c.index.level], 0);
  assert.throws(() => machineRig(m, CLIPS)(100, [{ name: 'level', to: 'bad', at: 0.05 }]), /event level=bad@0.05: "level" takes a number/);
  // A hit area's own action may write an out-value.
  const h = advance(c, start(c), 10, [{ at: 5, value: 'bounced', to: true, hit: true }], clock);
  assert.equal(h.vals[c.index.bounced], true);
});

test('inspect counts only the writes made by the sampled time', () => {
  const { m } = setup();
  const rig = machineRig(m, CLIPS);
  assert.deepEqual(rig.inspect(1000, [{ name: 'live', to: true, at: 0.3 }, { name: 'live', to: false, at: 5 }]).writes_ms, [300]);
});
