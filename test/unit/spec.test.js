import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { colorDistance, judgeBeats, judgePoints, parseColor, pointGroups, readSpec, specPath } from '../../src/spec.js';
import { tmp, write } from './helpers.js';

// 0 to 1000 ms: the body hops (y falls from 100 to 40 and back between 200 and 600 ms) while it breathes (sy moves all the
// time); `wide` squashes during the hop; `lid` blinks after it; `early` moves before it.
const t_ms = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
const samples = {
  t_ms,
  channels: {
    lid: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    wide: [0, 0, 0, 0.5, 1, 0.5, 0, 0, 0, 0, 0],
    early: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  parts: {
    body: {
      x: t_ms.map(() => 118),
      y: [100, 100, 100, 70, 40, 70, 100, 100, 100, 100, 100],
      sy: t_ms.map((t) => 1 + 0.02 * Math.sin(t / 50)),
    },
  },
};

const judge = (beats) => judgeBeats({ beats }, samples);
const beat = (r, name) => r.beats.find((b) => b.name === name);
const hop = { name: 'hop', part: 'body', direction: 'up' };

test('direction: a part going up means y falls; a beat the other way is a finding with a fix', () => {
  const met = judge([hop]);
  assert.deepEqual(met.findings, []);
  assert.deepEqual([beat(met, 'hop').from, beat(met, 'hop').reached, beat(met, 'hop').met], [100, 40, true]);
  const unmet = judge([{ ...hop, direction: 'down' }]);
  assert.equal(unmet.findings.length, 1);
  assert.equal(unmet.findings[0].ruleId, 'skac/spec-beat');
  assert.equal(unmet.findings[0].beat, 'hop');
  assert.match(unmet.findings[0].fix, /up means y falls/);
  // A channel goes up when its value rises.
  assert.deepEqual(judge([{ name: 'w', channel: 'wide', direction: 'up' }]).findings, []);
  assert.equal(judge([{ name: 'w', channel: 'wide', direction: 'down' }]).findings.length, 1);
});

test('span: the dominant move, so breathing sy does not stretch the hop over the whole clip', () => {
  const r = judge([{ name: 'hop', part: 'body' }]);
  assert.equal(beat(r, 'hop').watches, 'body.y');
  assert.deepEqual(beat(r, 'hop').span_ms, [200, 600]);
});

test('span: one channel that breathes all the time and makes one big move spans the big move', () => {
  const breath = t_ms.map((t, i) => 0.02 * Math.sin(t / 50) + [0, 0, 0, 0.5, 1, 0.5, 0, 0, 0, 0, 0][i]);
  const s = { ...samples, channels: { ...samples.channels, breath } };
  const r = judgeBeats({ beats: [{ name: 'big', channel: 'breath' }, { name: 'blink', channel: 'lid', after: 'big' }] }, s);
  assert.deepEqual(beat(r, 'big').span_ms, [200, 600]);
  assert.deepEqual(beat(r, 'blink').window_ms, [600, 1000]);
});

test('after: the window starts where the followed beat\'s span ends', () => {
  const met = judge([hop, { name: 'blink', channel: 'lid', after: 'hop' }]);
  assert.deepEqual(met.findings, []);
  assert.deepEqual(beat(met, 'blink').window_ms, [600, 1000]);
  const unmet = judge([hop, { name: 'twitch', channel: 'early', after: 'hop' }]);
  assert.equal(unmet.findings.length, 1);
  assert.match(unmet.findings[0].message, /does not move after "hop"/);
  assert.equal(beat(unmet, 'twitch').met, false);
});

test('overlaps: the window is the other beat\'s span', () => {
  const met = judge([hop, { name: 'squash', channel: 'wide', overlaps: 'hop' }]);
  assert.deepEqual(met.findings, []);
  assert.deepEqual(beat(met, 'squash').window_ms, [200, 600]);
  const unmet = judge([hop, { name: 'blink', channel: 'lid', overlaps: 'hop' }]);
  assert.equal(unmet.findings.length, 1);
  assert.match(unmet.findings[0].message, /does not move while "hop" runs/);
});

test('reaches: the farthest value of a channel inside the window, against min and max', () => {
  const met = judge([{ name: 'blink', channel: 'lid', from_ms: 600, to_ms: 1000, reaches: { channel: 'lid', min: 0.9 } }]);
  assert.deepEqual(met.findings, []);
  assert.deepEqual(beat(met, 'blink').reaches, { channel: 'lid', reached: 1, min: 0.9 });
  const unmet = judge([{ name: 'blink', channel: 'lid', from_ms: 0, to_ms: 500, reaches: { channel: 'lid', min: 0.9 } }]);
  assert.equal(unmet.findings.length, 1);
  assert.deepEqual([unmet.findings[0].value, unmet.findings[0].limit], [0, 0.9]);
  const over = judge([{ name: 'sq', channel: 'wide', reaches: { channel: 'wide', max: 0.8 } }]);
  assert.match(over.findings[0].message, /at most 0.8/);
});

test('unknown names are errors that list the known ones; so are loops and bad directions', () => {
  const r = judge([
    { name: 'a', channel: 'nope' },
    { name: 'b', part: 'ghost' },
    { name: 'c', channel: 'lid', after: 'nobody' },
    { name: 'd', channel: 'lid', from_ms: 0, reaches: { channel: 'nope', min: 1 } },
    { name: 'e', channel: 'lid', after: 'f' },
    { name: 'f', channel: 'lid', after: 'e' },
    { name: 'g', channel: 'lid', direction: 'left' },
    { name: 'h', part: 'body', direction: 'sideways' },
    { channel: 'lid' },
    { name: 'x', channel: 'lid', from_ms: 0, to_ms: 500, overlaps: 'typo' },
  ]);
  const by = Object.fromEntries(r.findings.map((f) => [f.beat, f]));
  assert.match(by.a.message, /channel "nope" is not in the rig/);
  assert.match(by.a.fix, /lid, wide, early/);
  assert.match(by.b.message, /part "ghost"/);
  assert.match(by.c.message, /"nobody" in after\/overlaps, which is not a beat/);
  assert.match(by.x.message, /"typo" in after\/overlaps/);
  assert.match(by.d.message, /reaches channel "nope"/);
  assert.match(by.e.message, /itself/);
  assert.match(by.g.message, /needs a part/);
  assert.match(by.h.message, /unknown direction/);
  assert.ok(r.findings.some((f) => f.beat === null && /no name/.test(f.message)));
  assert.ok(r.findings.every((f) => f.ruleId === 'skac/spec-beat' && f.severity === 'error' && f.fix));
});

test('points: colours within 24 per channel pass; a farther one fails with part: name', () => {
  assert.deepEqual(parseColor('#57A5E0'), [255, 0x57, 0xa5, 0xe0]);
  assert.deepEqual(parseColor('8057A5E0'), [0x80, 0x57, 0xa5, 0xe0]);
  assert.equal(parseColor('blue'), null);
  assert.equal(colorDistance([255, 0, 0, 0], [255, 10, 30, 0]), 30);
  const pts = [{ name: 'eye', x: 10, y: 20, color: '#57A5E0' }, { name: 'cheek', x: 30, y: 40, color: '#FF0000' }, { name: 'sky', x: 1, y: 1, color: '#000000' }];
  const f = judgePoints(pts, ['FF60A0E0', 'FF00FF00', null]);
  assert.deepEqual(f.map((x) => [x.ruleId, x.part]), [['skac/spec-point', 'cheek'], ['skac/spec-point', 'sky']]);
  assert.match(f[1].message, /outside the frame/);
  const g = pointGroups({ points: [...pts, { name: 'late', x: 1, y: 2, color: '#fff000', at: 4.5 }, { x: 1 }] });
  assert.deepEqual(g.groups.map((x) => [x.at, x.points.length]), [[0, 3], [4.5, 1]]);
  assert.equal(g.findings.length, 1);
});

test('readSpec: no file, bad JSON and a non-array beats each say so', () => {
  const dir = tmp();
  const file = specPath(join(dir, 'src', 'A.tsx'), 'A');
  assert.equal(file, join(dir, 'src', 'A.spec.json'));
  assert.deepEqual(readSpec(file), { spec: null, file });
  write(file, '{ nope');
  assert.match(readSpec(file).error, /not valid JSON/);
  write(file, '{ "beats": {} }');
  assert.match(readSpec(file).error, /"beats" .* not an array/);
  write(file, '{ "beats": [] }');
  assert.deepEqual(readSpec(file).spec, { beats: [] });
});
