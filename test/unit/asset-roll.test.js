import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execute } from '../../src/cli.js';
import { loadModules, tmp } from './helpers.js';

const { R, B } = loadModules({ R: './runtime/asset-roll.ts', B: './runtime/asset-bounds.ts' });
const shown = (frame) => frame.places.map(({ current, next, turn }) => (turn ? `${current}>${next}@${turn.toFixed(2)}` : `${current}`)).join(' ');

test('roll: a value splits into prefix, one run of digits and suffix, in any decimal system', () => {
  assert.deepEqual(R.parseRoll('+12 coins'), { prefix: '+', digits: [1, 2], suffix: ' coins', zero: 0x30 });
  assert.deepEqual(R.parseRoll('۱۲+'), { prefix: '', digits: [1, 2], suffix: '+', zero: 0x6f0 });
  assert.equal(R.parseRoll('1,250'), undefined); // two runs
  assert.equal(R.parseRoll('1۲'), undefined); // two systems
  assert.equal(R.parseRoll('none'), undefined);
  // Digits outside the first plane (two UTF-16 units each) split and roll by code point: mathematical bold 1 2.
  assert.deepEqual(R.parseRoll('+\u{1D7CF}\u{1D7D0}'), { prefix: '+', digits: [1, 2], suffix: '', zero: 0x1d7ce });
  assert.equal(R.restText(R.rollFrame('+\u{1D7CF}\u{1D7D0}', '+\u{1D7D1}\u{1D7D2}', 1)), '+\u{1D7D1}\u{1D7D2}');
});

const LINEAR = { ease: 'linear' };

test('roll: the rightmost place turns fastest, a place turns only while the one below wraps', () => {
  assert.equal(shown(R.rollFrame('+3', '+12', 0)), '-1 3');
  assert.equal(shown(R.rollFrame('+3', '+12', 1)), '1 2');
  // 3 -> 12 at 0.5 is 7.5: the units are half way from 7 to 8, the tens still blank.
  assert.equal(shown(R.rollFrame('+3', '+12', 0.5, LINEAR)), '-1 7>8@0.50');
  // 9.5: the units turn 9 -> 0 and the tens enter from blank at the same rate.
  assert.equal(shown(R.rollFrame('+3', '+12', 6.5 / 9, LINEAR)), '-1>1@0.50 9>0@0.50');
  // 95 -> 105 at 0.45 is 99.5: all three places turn together, the hundreds from blank.
  assert.equal(shown(R.rollFrame('95', '105', 0.45, LINEAR)), '-1>1@0.50 9>0@0.50 9>0@0.50');
  assert.equal(shown(R.rollFrame('95', '105', 0.25, LINEAR)), '-1 9 7>8@0.50');
});

test('roll: ease out (the default) slows into the new value, so its last turns read', () => {
  // 3 -> 12 half way through the time: linear shows 7.5, ease out 1 - 0.5^3 = 0.875 of the way, 10.875.
  assert.equal(shown(R.rollFrame('+3', '+12', 0.5)), '1 0>1@0.88');
  assert.equal(shown(R.rollFrame('+3', '+12', 0.5, { ease: 'out' })), '1 0>1@0.88');
  assert.equal(shown(R.rollFrame('+3', '+12', 1)), '1 2');
});

test('roll: a place smears above 30 turns a second and lands sharp: 0 to 240 over 600 ms', () => {
  const timing = { ms: 600 };
  const smears = (t) => R.rollFrame('0', '240', t / 600, timing).places.map(({ smear }) => Math.round(smear * 100) / 100);
  // At 100 ms the units turn at 240 x 3 x (5/6)^2 / 0.6 = 833 a second and the tens at 83: both smeared; the hundreds at 8 are sharp.
  assert.deepEqual(smears(100), [0, 1, 1]);
  // At 300 ms: units 300 a second (smeared), tens 30 (just sharp), hundreds 3.
  assert.deepEqual(smears(300), [0, 0, 1]);
  // At 550 ms the units turn 8 times a second: every place is sharp, and the value is 239.8 on its way to 240.
  assert.deepEqual(smears(550), [0, 0, 0]);
  assert.deepEqual(smears(600), [0, 0, 0]);
  // 7 to 8 turns once: never a smear.
  for (const t of [0, 100, 300, 550]) assert.deepEqual(R.rollFrame('7', '8', t / 600, timing).places.map(({ smear }) => smear), [0]);
  // Before the roll starts and after it ends nothing smears, though ease out is steepest at the start: 42 to 45 over 260 ms.
  const short = { ms: 260 };
  assert.deepEqual(R.rollFrame('42', '45', 0, short).places.map(({ smear }) => smear), [0, 0]);
  assert.deepEqual(R.rollFrame('42', '45', 1, short).places.map(({ smear }) => smear), [0, 0]);
  assert.ok(R.rollFrame('42', '45', 0.01, short).places[1].smear > 0, 'just after the start the ones turn about 34 times a second');
  // Without the timing (no clip moves the channel) nothing smears.
  assert.deepEqual(R.rollFrame('0', '240', 0.1).places.map(({ smear }) => smear), [0, 0, 0]);
});

test('roll: rollSpan is the time the progress channel takes from 0 to 1, the fastest clip winning', () => {
  const clips = { slow: { tracks: { turn: [[0, 0], [200, 0], [1400, 1]] } }, fast: { tracks: { turn: [[0, 0], [600, 1], [900, 1]] } }, still: { tracks: { turn: [[0, 1]] } } };
  assert.equal(R.rollSpan(clips, 'turn'), 600);
  assert.equal(R.rollSpan({ half: { tracks: { turn: [[0, 0.5], [300, 1]] } } }, 'turn'), 600);
  assert.equal(R.rollSpan(clips, 'other'), undefined);
});

test('roll: zero padding the string writes is kept, at rest and while it rolls', () => {
  assert.equal(R.restText(R.rollFrame('000120', '000150', 0)), '000120');
  assert.equal(R.restText(R.rollFrame('000120', '000150', 1)), '000150');
  // Half way in time, ease out puts the value at 146.25: the padding zeros stay, only the tens and ones turn.
  assert.equal(shown(R.rollFrame('000120', '000150', 0.5)), '0 0 0 1 4 6>7@0.25');
  // Places beyond a shorter string stay blank as before: 95 to 105 opens its hundreds.
  assert.equal(shown(R.rollFrame('95', '105', 0)), '-1 9 5');
});

test('roll: check reads a zero-padded roll as the phone draws it, padding kept at rest, mid-roll and across a carry', () => {
  const node = { kind: 'text', text: { value: 'to' }, roll: { progress: 'turn', from: 'from', ease: 'linear' }, x: 0, y: 0, width: 100, fontSize: 20 };
  const asset = { channels: { turn: 0 }, machine: { values: {} } };
  const shown = (from, to, turn) => B.shownText(node, { from, to }, asset, { turn });
  assert.equal(shown('000120', '000150', 0), '000120');
  assert.equal(shown('000120', '000150', 0.5), '000135');
  assert.equal(shown('000120', '000150', 1), '000150');
  // A carry across a padding zero turns it like any place, up and down.
  assert.equal(shown('000099', '000100', 0.75), '000100');
  assert.equal(shown('000099', '000100', 1), '000100');
  assert.equal(shown('000100', '000099', 0.75), '000099');
  assert.equal(shown('000100', '000099', 0), '000100');
  // Unpadded, a place beyond the shorter number is blank until the value reaches it.
  assert.equal(shown('95', '105', 0.25), '98'); // 97.5: a place shows its next digit from half a turn
});

test('roll: a row moves its rolling text by the share of width it has opened, so the gap holds', () => {
  // 3 to 12 opens one place: nothing until the value reaches 9, all of it by 10.
  assert.equal(R.rollWidthShare('+3', '+12', 0, LINEAR), 0);
  assert.equal(R.rollWidthShare('+3', '+12', 6.5 / 9, LINEAR), 0.5);
  assert.equal(R.rollWidthShare('+3', '+12', 1, LINEAR), 1);
  // As many places at both ends: the eased value's share.
  assert.equal(R.rollWidthShare('120', '150', 0.5), 0.875);
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

test('roll: the phone draw (CanvasKit) smears the fast places of 0 to 240 and lands sharp', async () => {
  const { loadCanvasKit } = await import('../../src/asset-text-layout.js');
  const cwd = tmp('asset-roll-smear-');
  const file = join(cwd, 'count.motion.json');
  writeFileSync(file, JSON.stringify({
    schema: 'skac.asset/1', name: 'Counter',
    artboard: { width: 200, height: 80, nodes: [{ kind: 'text', text: { value: 'to' }, roll: { progress: 'turn', from: 'from' },
      x: 20, y: 20, width: 160, fontSize: 32, fill: '#1D2B2A', align: 'center' }] },
    channels: { turn: 0 }, clips: { run: { ms: 600, tracks: { turn: [[0, 0], [600, 1]] } } },
    machine: { schema: 'skac.machine/1', values: { from: { type: 'string', default: '0' }, to: { type: 'string', default: '240' } },
      layers: [{ name: 'r', entry: 'run', states: { run: { clip: 'run', loop: 'once' } } }] },
  }));
  const kit = await loadCanvasKit();
  // The sharpest step down each third of the number's width: the largest change between two pixels one above the other. A sharp
  // digit's horizontal edges step by most of the ink's contrast; a vertical blur leaves only soft steps.
  const steepest = async (t) => {
    const { file: png } = await execute(['asset', 'frame', file, `--trace=${t}`, '--size=400x160', `--out=${t}.png`, '--background=#FFFFFF'], cwd);
    const image = kit.MakeImageFromEncoded(readFileSync(png));
    const width = image.width();
    const px = image.readPixels(0, 0, { width, height: image.height(), colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    const thirds = [0, 0, 0];
    for (let i = width * 4; i < px.length; i += 4) {
      const x = (i / 4) % width;
      const y = Math.floor(i / 4 / width);
      // Inside the line, away from the column window's own top and bottom edges (the line box is 40 to about 116 at this scale).
      if (x < 130 || x >= 270 || y < 48 || y > 108) continue;
      const third = Math.floor((x - 130) / (140 / 3));
      thirds[third] = Math.max(thirds[third], Math.abs(px[i] - px[i - width * 4]));
    }
    return thirds;
  };
  const [rest, early, middle, landing] = [await steepest(600), await steepest(100), await steepest(300), await steepest(550)];
  const sharp = (step) => step > 120;
  const soft = (step) => step < 60;
  assert.ok(rest.every(sharp), `rest ${rest}`);
  assert.ok(sharp(early[0]) && soft(early[1]) && soft(early[2]), `100 ms: hundreds sharp, tens and units smeared: ${early}`);
  assert.ok(sharp(middle[0]) && sharp(middle[1]) && soft(middle[2]), `300 ms: units smeared: ${middle}`);
  assert.ok(landing.every(sharp), `550 ms: sharp: ${landing}`);
});
