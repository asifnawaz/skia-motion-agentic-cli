import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execute } from '../../src/cli.js';
import { loadModules, tmp } from './helpers.js';

const { R } = loadModules({ R: './runtime/asset-roll.ts' });
const shown = (frame) => frame.places.map(({ current, next, turn }) => (turn ? `${current}>${next}@${turn.toFixed(2)}` : `${current}`)).join(' ');

test('roll: a value splits into prefix, one run of digits and suffix, in any decimal system', () => {
  assert.deepEqual(R.parseRoll('+12 coins'), { prefix: '+', digits: [1, 2], suffix: ' coins', zero: 0x30 });
  assert.deepEqual(R.parseRoll('۱۲+'), { prefix: '', digits: [1, 2], suffix: '+', zero: 0x6f0 });
  assert.equal(R.parseRoll('1,250'), undefined); // two runs
  assert.equal(R.parseRoll('1۲'), undefined); // two systems
  assert.equal(R.parseRoll('none'), undefined);
});

test('roll: the rightmost place turns fastest, a place turns only while the one below wraps', () => {
  assert.equal(shown(R.rollFrame('+3', '+12', 0)), '-1 3');
  assert.equal(shown(R.rollFrame('+3', '+12', 1)), '1 2');
  // 3 -> 12 at 0.5 is 7.5: the units are half way from 7 to 8, the tens still blank.
  assert.equal(shown(R.rollFrame('+3', '+12', 0.5)), '-1 7>8@0.50');
  // 9.5: the units turn 9 -> 0 and the tens enter from blank at the same rate.
  assert.equal(shown(R.rollFrame('+3', '+12', 6.5 / 9)), '-1>1@0.50 9>0@0.50');
  // 95 -> 105 at 0.45 is 99.5: all three places turn together, the hundreds from blank.
  assert.equal(shown(R.rollFrame('95', '105', 0.45)), '-1>1@0.50 9>0@0.50 9>0@0.50');
  assert.equal(shown(R.rollFrame('95', '105', 0.25)), '-1 9 7>8@0.50');
});

test('roll: counting down turns the same columns back, and the width stays the longer value', () => {
  assert.equal(shown(R.rollFrame('12', '3', 0)), '1 2');
  assert.equal(shown(R.rollFrame('12', '3', 1)), '-1 3');
  assert.equal(R.rollFrame('12', '3', 0.5).places.length, 2);
});

test('roll: Urdu digits roll in their own glyphs; mismatched values cut', () => {
  const frame = R.rollFrame('۳', '۱۲', 1);
  assert.equal(frame.places.map(({ current }) => R.digitText(current, frame.zero)).join(''), '۱۲');
  assert.equal(R.rollFrame('+3', '3', 0.5), undefined); // prefix differs
  assert.equal(R.rollFrame('3', '۳', 0.5), undefined); // systems differ
});


// A counter that rolls from its old value to its new one as `turn` runs 0 to 1 over 600 ms, after the host sets both values.
function rolling(extra = {}) {
  return {
    schema: 'skac.asset/1', name: 'RollingCounter',
    artboard: { width: 160, height: 60, nodes: [{
      id: 'count', kind: 'text', text: { value: 'count' }, roll: { progress: 'turn', from: 'previous' },
      x: 20, y: 18, width: 120, fontSize: 20, fill: '#1D2B2A', align: 'center', ...extra,
    }] },
    channels: { turn: 0 },
    clips: { idle: { ms: 0, tracks: {} }, roll: { ms: 600, reducedAt: 600, tracks: { turn: [[0, 0], [600, 1, 'inOut']] } } },
    machine: { schema: 'skac.machine/1',
      values: { previous: { type: 'string', default: '+9' }, count: { type: 'string', default: '+12' }, go: { type: 'trigger' } },
      layers: [{ name: 'counter', entry: 'idle', states: { idle: { clip: 'idle' }, roll: { clip: 'roll', loop: 'once' } },
        transitions: [{ from: 'idle', to: 'roll', when: [['go']] }] }] },
  };
}

const run = async (asset, ...args) => {
  const cwd = tmp('asset-roll-');
  const file = join(cwd, 'counter.motion.json');
  writeFileSync(file, JSON.stringify(asset));
  return { cwd, result: await execute(['asset', ...args.map((arg) => (arg === '@' ? file : arg))], cwd) };
};

test('roll: a text with roll validates its channel and from-value', async () => {
  await assert.rejects(run(rolling({ roll: { progress: 'missing', from: 'previous' } }), 'check', '@'), /roll\.progress: expected a declared channel/);
  await assert.rejects(run(rolling({ roll: { progress: 'turn', from: 'go' } }), 'check', '@'), /roll\.from: expected a string value from machine\.values/);
  await assert.rejects(run(rolling({ text: '+12' }), 'check', '@'), /a rolling text binds its to-value/);
});

test('roll: the SVG frame draws one clipped column per place, and asset check measures the digits it shows', async () => {
  const { result } = await run(rolling(), 'frame', '@', '--trace=300', '--commands=go@0');
  const svg = readFileSync(result.file, 'utf8');
  // At 300 ms the inOut curve is half way: 9 + 1.5 = 10.5, so the units turn 0 -> 1 and the tens show 1.
  assert.equal((svg.match(/<clipPath id="roll-/g) ?? []).length, 2);
  assert.match(svg, />\+<\/text>/);
  const { result: checked } = await run(rolling(), 'check', '@', '--commands=go@0');
  assert.equal(checked.ok, true);
  // Each number the roll shows on the way (+9, +10, +11, +12) is laid out and measured.
  assert.deepEqual(checked.textClear.textBoxes, { layout: 4, declared: 0 });
});

test('roll: asset check warns about the runtime it needs, and about values it cannot roll', async () => {
  const { result } = await run(rolling(), 'check', '@', '--commands=previous="1.200"@0 count="1.300"@0 go@0.1');
  const codes = result.warnings.map(({ code }) => code);
  assert.ok(codes.includes('roll-runtime'));
  assert.ok(result.warnings.some(({ code, error }) => code === 'roll-cut' && error.startsWith('"1.200" to "1.300" cannot roll')));
});

test('roll: at rest a frame reads as its plain number, and a rolling text is styled with tabular figures', () => {
  assert.equal(R.restText(R.rollFrame('+98', '+102', 0)), '+98');
  assert.equal(R.restText(R.rollFrame('+98', '+102', 1)), '+102');
  assert.equal(R.restText(R.rollFrame('۹۸%', '۱۰۲%', 1)), '۱۰۲%');
  const node = { kind: 'text', roll: { progress: 'p', from: 'f' }, fontFeatures: [{ name: 'liga', value: 0 }] };
  assert.deepEqual(R.rollTextStyle(node).fontFeatures, [{ name: 'liga', value: 0 }, { name: 'tnum', value: 1 }]);
  const plain = { kind: 'text' };
  assert.equal(R.rollTextStyle(plain), plain);
});
