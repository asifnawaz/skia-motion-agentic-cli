import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleRig } from '../../src/rig.js';
import { CATEGORIES, RULES, runRules, describe } from '../../src/rules.js';

const META = { fps: 30, frames: 90, width: 780, height: 1734, scale: 2 };
const smooth = (p) => {
  const q = Math.min(1, Math.max(0, p));
  return q * q * (3 - 2 * q);
};
const easeOut = (p) => 1 - (1 - Math.min(1, Math.max(0, p))) ** 3;
/** Sample a synthetic rig and run one rule on it. */
const run = (id, rig, over = {}) => {
  const meta = { ...META, ...over };
  return RULES[id].check(sampleRig(rig, meta), meta);
};
const part = (x, y = 300) => ({ x, y, w: 40, h: 40 });

// Calibrated against skac-e2e's mutation set (13 Nov): each of these is failed by the fault built to trip it and
// passed by the base combo, so it defaults to error. The rest stay warn until a mutation proves them.
const CALIBRATED = ['skac/min-change', 'skac/overshoot', 'skac/beat-moves', 'skac/ground', 'skac/attached'];

test('every rule is rig layer with docs and needs; calibrated rules default to error, the rest to warn', () => {
  const ids = Object.keys(RULES);
  assert.equal(ids.length, 11);
  for (const id of ids) {
    assert.match(id, /^skac\//);
    assert.equal(RULES[id].layer, 'rig');
    assert.equal(RULES[id].default, CALIBRATED.includes(id) ? 'error' : 'warn', id);
    assert.match(RULES[id].docs, /^motion\//);
    assert.ok(Array.isArray(RULES[id].needs));
    assert.ok(CATEGORIES.includes(RULES[id].category), `${id} has a category`);
  }
});

test('verdicts: a NaN channel is a skac/samples error with the channel and first time, and no rule runs on it', () => {
  const meta = { ...META, face: ['a'], beats: [{ name: 'b', from_ms: 0, to_ms: 500, channel: 'a' }], settle: { a: 0 }, loop: true, events: [] };
  const s = sampleRig((ms) => ({ channels: ms < 1000 ? { a: 0, b: 1 } : { b: 1 }, parts: { body: part(10) } }), meta);
  const r = runRules(s, meta);
  assert.equal(r.findings.length, 1);
  assert.deepEqual([r.findings[0].ruleId, r.findings[0].severity, r.findings[0].channel, r.findings[0].at_s], ['skac/samples', 'error', 'a', 1]);
  assert.ok(Object.values(r.counts).every((c) => !c.checked));
  const empty = runRules(sampleRig(() => ({ channels: {} }), META), META);
  assert.match(empty.findings[0].message, /no channels and no parts/);
});

test('verdicts: with every rule off, runRules returns skac/no-rules as an error', () => {
  const off = Object.fromEntries(Object.keys(RULES).map((id) => [id, 'off']));
  const s = sampleRig(() => ({ channels: { a: 0 } }), META);
  const r = runRules(s, META, off);
  assert.deepEqual(r.findings.map((f) => [f.ruleId, f.severity, f.category]), [['skac/no-rules', 'error', 'request']]);
  assert.ok(!runRules(s, META).findings.some((f) => f.ruleId === 'skac/no-rules'));
});

test('verdicts: every finding carries a category, and counts give each rule checked and findings', () => {
  const meta = { ...META, settle: { sy: 1 }, face: ['sy'], beats: [{ name: 'x', from_ms: 2000, to_ms: 2500, channel: 'sy' }] };
  const rig = (ms) => ({ channels: { sy: ms < 500 ? 1.2 * smooth(ms / 500) : 1.2 - 0.2 * smooth((ms - 500) / 300) }, parts: { b: part(ms * 0.8) } });
  const r = runRules(sampleRig(rig, meta), meta, { 'skac/dead-hold': 'off' });
  assert.ok(r.findings.length >= 3);
  assert.ok(r.findings.every((f) => CATEGORIES.includes(f.category)));
  assert.deepEqual(Object.keys(r.counts).sort(), Object.keys(RULES).sort());
  assert.deepEqual(r.counts['skac/dead-hold'], { checked: false, findings: 0 });
  assert.deepEqual(r.counts['skac/loop-seam'], { checked: false, findings: 0 }); // skipped: no meta.loop
  for (const [id, c] of Object.entries(r.counts)) if (c.checked) assert.equal(c.findings, r.findings.filter((f) => f.ruleId === id).length);
  assert.ok(r.counts['skac/speed-cap'].findings >= 1);
});

test('speed-cap: a slow part passes, a fast part names the part, time and fix', () => {
  assert.deepEqual(run('skac/speed-cap', (ms) => ({ channels: {}, parts: { body: part(ms * 0.3) } })), []);
  const f = run('skac/speed-cap', (ms) => ({ channels: {}, parts: { body: part(ms * 0.8) } }));
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, 'skac/speed-cap');
  assert.equal(f[0].part, 'body');
  assert.equal(f[0].limit, 0.54);
  assert.ok(Math.abs(f[0].value - 0.8) < 0.01);
  assert.match(f[0].message, /body/);
  assert.match(f[0].fix, /lengthen/);
  assert.equal(f[0].docs, 'motion/anticipation');
});

test('speed-cap measures a part at its box centre: a squash about the feet is not travel', () => {
  // The top edge falls 0.8 pt/ms while the feet stay on the ground: the centre moves half that, under the cap.
  const squash = (ms) => {
    const h = Math.max(40, 200 - ms * 0.8);
    return { channels: {}, parts: { body: { x: 100, y: 600 - h, w: 80, h } } };
  };
  assert.deepEqual(run('skac/speed-cap', squash, { frames: 6 }), []);
  // The same top-edge speed as travel, with the box rigid, fails.
  const drop = (ms) => ({ channels: {}, parts: { body: { x: 100, y: 400 + Math.min(160, ms * 0.8), w: 80, h: 200 } } });
  assert.equal(run('skac/speed-cap', drop, { frames: 6 }).length, 1);
});

test('parents: a wing carried by a fast body passes speed-cap on its own swing; a world wing fails', () => {
  const carried = (ms) => ({ channels: {}, parts: { body: part(ms * 0.53), wing: part(ms * 0.53 + 40 * smooth(ms / 1000), 400) } });
  const world = run('skac/speed-cap', carried);
  assert.deepEqual(world.map((f) => f.part), ['wing']); // the body's 0.53 pt/ms plus the swing's 0.06
  assert.deepEqual(run('skac/speed-cap', carried, { parents: { wing: 'body' } }), []);
  const swing = (ms) => ({ channels: {}, parts: { body: part(ms * 0.3), wing: part(ms * 0.3 + ms * 0.6, 400) } });
  const k = run('skac/speed-cap', swing, { parents: { wing: 'body' } });
  assert.deepEqual(k.map((f) => f.part), ['wing']);
  assert.match(k[0].message, /relative to `body`/);
  const bad = run('skac/speed-cap', carried, { parents: { wing: 'torso' } });
  assert.ok(bad.some((f) => /torso/.test(f.message)));
});

test('one grid: every rule gives the same findings at 30, 60 and 120 fps', () => {
  const rig = (ms) => ({
    channels: { wide: ms < 1500 ? 0 : 1, lid: smooth((ms - 400) / 300), sy: 1 + 0.1 * Math.sin(ms / 90) },
    parts: { body: part(Math.min(ms, 2000) * 0.6), wing: part(150 * smooth((ms - 500) / 600), 400), tail: part(30 + 40 * smooth((ms - 520) / 600), 500) },
  });
  const over = { events: [{ name: 'tap', at: 2.5 }], beats: [{ name: 'shock', from_ms: 1400, to_ms: 1600, channel: 'wide' }],
    settle: { sy: 1 }, face: ['wide', 'lid'], loop: true, parents: { wing: 'body' } };
  const at = (fps) => {
    const meta = { ...META, ...over, fps, frames: 3 * fps };
    return runRules(sampleRig(rig, meta), meta);
  };
  const r30 = at(30);
  assert.ok(r30.findings.length >= 4); // the fixture trips several rules, so equality is not between empty lists
  assert.deepEqual(at(60), r30);
  assert.deepEqual(at(120), r30);
});

test('min-change: a 200 ms ramp passes, a one-frame swap fails', () => {
  const ramp = (ms) => ({ channels: { wide: smooth((ms - 1000) / 200) } });
  assert.deepEqual(run('skac/min-change', ramp, { face: ['wide'] }), []);
  const swap = (ms) => ({ channels: { wide: ms < 1000 ? 0 : 1 } });
  const f = run('skac/min-change', swap, { face: ['wide'] });
  assert.equal(f.length, 1);
  assert.equal(f[0].channel, 'wide');
  assert.ok(f[0].value < 100);
  assert.equal(f[0].limit, 100);
  assert.deepEqual(run('skac/min-change', swap, { face: ['other'] }), []);
});

test('min-change: the faces.md blink (close 110 ms, hold 40, reopen 190) passes; a 50 ms close fails', () => {
  const blink = (close) => (ms) => {
    const t = ms - 1000;
    const lid = t < close ? smooth(t / close) : t < close + 40 ? 1 : 1 - easeOut((t - close - 40) / 190);
    return { channels: { lid } };
  };
  assert.deepEqual(run('skac/min-change', blink(110), { face: ['lid'] }), []);
  const f = run('skac/min-change', blink(50), { face: ['lid'] });
  assert.equal(f.length, 1);
  assert.ok(f[0].value < 100 && f[0].value >= 40, `close measured over its whole run: ${f[0].value}`);
});

test('min-change known limit: a slow lead-in then a snap in the same direction is one run and passes', () => {
  // Pinned so a change to the measure is a decision: the run is 300 ms long, though most of it happens in one step.
  const lead = (ms) => ({ channels: { wide: ms < 1000 ? 0 : ms < 1300 ? 0.05 * ((ms - 1000) / 300) : 1 } });
  assert.deepEqual(run('skac/min-change', lead, { face: ['wide'] }), []);
});

test('overshoot: a landing at 4% passes, 15% fails with the channel', () => {
  const to = (peak) => (ms) => ({
    channels: { sy: ms < 500 ? peak * smooth(ms / 500) : peak + (1 - peak) * smooth((ms - 500) / 300) },
  });
  assert.deepEqual(run('skac/overshoot', to(1), { settle: { sy: 1 } }), []);
  assert.deepEqual(run('skac/overshoot', to(1.04), { settle: { sy: 1 } }), []);
  const f = run('skac/overshoot', to(1.15), { settle: { sy: 1 } });
  assert.equal(f.length, 1);
  assert.equal(f[0].channel, 'sy');
  assert.equal(f[0].limit, 0.05);
  assert.ok(f[0].value > 0.1);
  assert.ok(Math.abs(f[0].at_s - 0.5) < 0.05);
});

test('in-frame: a centred part passes, one past the right edge or in the 4% margin fails', () => {
  const at = (x, y) => () => ({ channels: {}, parts: { body: { x, y, w: 50, h: 50 } } });
  assert.deepEqual(run('skac/in-frame', at(170, 400)), []); // frame is 390 x 867 pt
  const out = run('skac/in-frame', at(370, 400));
  assert.equal(out.length, 1);
  assert.equal(out[0].part, 'body');
  assert.ok(out[0].value > 0);
  assert.equal(run('skac/in-frame', at(10, 400)).length, 1); // 10 pt < 4% of 390 = 15.6
});

test('idle-cadence: bumps every 1.5 s pass, a still lead-in fails', () => {
  const events = [{ name: 'tap', at: 4 }];
  const bump = (ms, at) => Math.sin(Math.min(1, Math.max(0, (ms - at) / 300)) * Math.PI) ** 2;
  const lively = (ms) => ({ channels: { a: bump(ms, 800) + bump(ms, 2300) + bump(ms, 3400) } });
  assert.deepEqual(run('skac/idle-cadence', lively, { events, frames: 150 }), []);
  const f = run('skac/idle-cadence', (ms) => ({ channels: { a: bump(ms, 3900) } }), { events, frames: 150 });
  assert.equal(f.length, 1);
  assert.equal(f[0].at_s, 0);
  assert.ok(f[0].value > 2000);
});

test('dead-hold: a breathing rig passes, a frozen rig fails', () => {
  assert.deepEqual(run('skac/dead-hold', (ms) => ({ channels: { a: Math.sin(ms / 200) }, parts: { b: part(100) } })), []);
  const f = run('skac/dead-hold', () => ({ channels: { a: 0.5 }, parts: { b: part(100) } }));
  assert.equal(f.length, 1);
  assert.ok(f[0].value > 500);
  assert.equal(f[0].at_s, 0);
});

test('loop-seam: a cycle passes, a ramp that jumps back fails, a non-loop is not checked', () => {
  const cycle = (ms) => ({ channels: { a: Math.sin((2 * Math.PI * ms) / 3000) } });
  assert.deepEqual(run('skac/loop-seam', cycle, { loop: true }), []);
  const ramp = (ms) => ({ channels: { a: ms / 3000 } });
  const f = run('skac/loop-seam', ramp, { loop: true });
  assert.equal(f.length, 1);
  assert.equal(f[0].channel, 'a');
  assert.deepEqual(run('skac/loop-seam', ramp, { loop: false }), []);
});

test('determinism: a pure rig passes, a rig with hidden state fails', () => {
  assert.deepEqual(run('skac/determinism', (ms) => ({ channels: { a: ms } })), []);
  let calls = 0;
  const f = run('skac/determinism', () => ({ channels: { a: calls++ } }));
  assert.ok(f.length >= 1);
  assert.equal(f[0].channel, 'a');
  assert.match(f[0].fix, /seeded/);
});

test('beat-moves: a moving beat passes; a still window and an unknown channel fail', () => {
  const rig = (ms) => ({ channels: { wide: smooth((ms - 1000) / 200), idle: 0 } });
  const beat = (channel, from_ms, to_ms) => ({ beats: [{ name: 'shock', from_ms, to_ms, channel }] });
  assert.deepEqual(run('skac/beat-moves', rig, beat('wide', 1000, 1200)), []);
  const still = run('skac/beat-moves', rig, beat('wide', 2000, 2200));
  assert.equal(still.length, 1);
  assert.equal(still[0].channel, 'wide');
  assert.match(still[0].message, /does not move/);
  const missing = run('skac/beat-moves', rig, beat('nope', 1000, 1200));
  assert.match(missing[0].message, /does not return/);
});

test('runRules skips a rule whose input is missing and reports it, never guesses', () => {
  const meta = { ...META };
  const s = sampleRig(() => ({ channels: { a: 0 } }), meta);
  const { skipped } = runRules(s, meta);
  const byId = Object.fromEntries(skipped.map((k) => [k.ruleId, k.missing]));
  assert.deepEqual(byId['skac/min-change'], ['face']);
  assert.deepEqual(byId['skac/overshoot'], ['settle']);
  assert.deepEqual(byId['skac/idle-cadence'], ['events']);
  assert.deepEqual(byId['skac/beat-moves'], ['beats']);
  assert.deepEqual(byId['skac/loop-seam'], ['loop']);
  assert.deepEqual(byId['skac/speed-cap'], ['parts']);
  assert.equal(byId['skac/dead-hold'], undefined);
});

test('runRules applies each rule\'s default, severities and off, and sorts by time', () => {
  const meta = { ...META, settle: { sy: 1 } };
  const rig = (ms) => ({ channels: { sy: ms < 500 ? 1.2 * smooth(ms / 500) : 1.2 - 0.2 * smooth((ms - 500) / 300) }, parts: { b: part(ms * 0.8) } });
  const s = sampleRig(rig, meta);
  const warn = runRules(s, meta);
  assert.ok(warn.findings.length >= 2);
  assert.ok(warn.findings.every((f) => f.severity === RULES[f.ruleId].default), JSON.stringify(warn.findings.map((f) => [f.ruleId, f.severity])));
  assert.ok(warn.findings.some((f) => f.severity === 'error') && warn.findings.some((f) => f.severity === 'warn'), 'overshoot (calibrated) is an error, speed-cap a warn');
  const times = warn.findings.map((f) => f.at_s);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  const strict = runRules(s, meta, { 'skac/speed-cap': 'error', 'skac/overshoot': 'off' });
  assert.ok(strict.findings.some((f) => f.ruleId === 'skac/speed-cap' && f.severity === 'error'));
  assert.ok(!strict.findings.some((f) => f.ruleId === 'skac/overshoot'));
  assert.ok(!strict.skipped.some((k) => k.ruleId === 'skac/overshoot'));
});

test('describe: an ease-out move reads as one text line, with events and beats beside it', () => {
  const meta = { ...META, events: [{ name: 'tap', at: 4 }], beats: [{ name: 'shock', from_ms: 4000, to_ms: 4200, channel: 'wide' }] };
  const rig = (ms) => ({ channels: { wide: easeOut((ms - 4000) / (400 / 3)) } });
  const lines = describe(sampleRig(rig, { ...meta, frames: 180 }), meta);
  assert.deepEqual(lines, [
    '4.00–4.20 s beat `shock` (`wide`): moves within 0–1 (range 1)',
    '4.00 s event `tap`',
    '4.00–4.13 s `wide` 0→1 (125 ms, ease-out)', // 120 Hz grid: the last step lands at 4125 ms
  ]);
});

test('describe: names ease-in, ease-in-out, linear and a one-frame cut; parts show distance and peak speed', () => {
  const one = (fn) => describe(sampleRig((ms) => ({ channels: { c: fn((ms - 1000) / 400) } }), { ...META, frames: 60 }), {});
  assert.match(one((p) => easeOut(1 - p) * -1 + 1)[0], /ease-in\)/); // 1-(1-q)^3 mirrored: slow start, fast end
  assert.match(one(smooth)[0], /ease-in-out/);
  assert.match(one((p) => Math.min(1, Math.max(0, p)))[0], /linear/);
  assert.match(one((p) => (p < 0 ? 0 : 1))[0], /cut/);
  const parts = describe(sampleRig((ms) => ({ channels: {}, parts: { body: part(1000 + 80 * easeOut((ms - 1000) / 400)) } }), { ...META, frames: 60 }), {});
  assert.equal(parts.length, 1);
  assert.match(parts[0], /part `body` \(1000, 300\)→\(1079\.\d+, 300\) pt, peak 0\.5\d pt\/ms at 1\.01 s/);
  assert.match(parts[0], /ease-out/);
});

test('describe: a beat on a still channel is marked and nothing moves for a flat rig', () => {
  const meta = { ...META, beats: [{ name: 'hop', from_ms: 500, to_ms: 900, channel: 'y' }] };
  const lines = describe(sampleRig(() => ({ channels: { y: 0 } }), meta), meta);
  assert.deepEqual(lines, ['0.50–0.90 s beat `hop` (`y`): does NOT move']);
});
