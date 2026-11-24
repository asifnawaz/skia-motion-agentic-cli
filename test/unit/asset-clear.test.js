import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../../src/cli.js';
import { boxGap, circleGap, travelChannels } from '../../src/asset-clear.js';
import { tmp } from './helpers.js';

// A bonus row: a label on the left, the value it pays into on the right. A coin flies down from the top; a ring plays where it lands.
// The broken flight ends beside the label, as a broken preview once did; the fixed one ends on the value.
function bonusRow({ landX, ringX, allow = false, landing = true, extra = {} }) {
  const label = { id: 'counterLabel', kind: 'text', text: 'Daily bonus', x: 40, y: 380, width: 170, fontSize: 18, fill: '#002D2A' };
  const value = { id: 'counterValue', kind: 'text', text: '+3 coins', x: 220, y: 380, width: 120, fontSize: 18, fill: '#002D2A' };
  const coin = { id: 'coin', kind: 'group', x: 'coinX', y: 'coinY', scaleX: 'coinScale', scaleY: 'coinScale', children: [
    { kind: 'ellipse', x: -8, y: -8, width: 16, height: 16, fill: '#FFFCF1' },
  ] };
  const ring = { id: 'payoffRing', kind: 'group', x: ringX, y: 391, scaleX: 'ringScale', scaleY: 'ringScale', children: [
    { kind: 'ellipse', x: -20, y: -20, width: 40, height: 40, fill: '#FFC25A', opacity: 'ringAlpha' },
  ] };
  return {
    schema: 'skac.asset/1', name: 'BonusRow', artboard: { width: 360, height: 520, nodes: [label, value, ring, coin] },
    channels: { coinX: 180, coinY: 90, coinScale: 1, ringScale: 0.5, ringAlpha: 0 },
    clips: { run: { ms: 1200, tracks: {
      coinX: [[0, 180], [200, 180], [800, landX, 'inOut']],
      coinY: [[0, 90], [200, 90], [800, 391, 'in']],
      coinScale: [[0, 1], [800, 1], [880, 0, 'in']],
      ringScale: [[0, 0.5], [800, 0.5], [900, 1.4, 'out'], [1100, 1]],
      ringAlpha: [[0, 0], [800, 0], [840, 0.8, 'out'], [1100, 0]],
    } } },
    machine: { schema: 'skac.machine/1', layers: [{ name: 'bonus', entry: 'run', states: { run: { clip: 'run', loop: 'once' } } }] },
    ...(landing && { landings: [{ node: 'coin', target: 'counterValue' }] }),
    ...(allow && { allowOverlap: [{ nodes: ['payoffRing', allow], reason: 'the ring frames this text on purpose' }] }),
    ...extra,
  };
}

function setup(asset, config) {
  const cwd = tmp('asset-clear-');
  const file = join(cwd, 'bonus.motion.json');
  writeFileSync(file, JSON.stringify(asset));
  if (config) writeFileSync(join(cwd, 'skia-motion.json'), JSON.stringify(config));
  return { cwd, file, run: (...args) => execute(['asset', ...args], cwd) };
}

const failure = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the check to fail');
};

test('a coin that lands beside the label fails its landing and text-clear, naming the pieces', async () => {
  const { file, run } = setup(bonusRow({ landX: 27, ringX: 50 }));
  const error = await failure(() => run('check', file));
  assert.match(error.message, /coin lands 194 pt outside counterValue at 800 ms \(tolerance 0 pt\)/);
  assert.match(error.message, /payoffRing \(artboard\.nodes\[2\]\.children\[0\]\) rests [\d.]+ pt over the text "Daily bonus" \(counterLabel\)/);
  const { problems, landings, textClear } = error.extra;
  assert.deepEqual(problems.map(({ check }) => check), ['skac/landing', 'skac/text-clear']);
  assert.deepEqual(landings[0].centre, { x: 27, y: 391 });
  assert.deepEqual(textClear.textBoxes, { layout: 2, declared: 0 });
});

test('the fixed flight lands on the value, and the ring on its target is the reaction, not a collision', async () => {
  // Anything drawn on a landing's target in the 400 ms after the landing is exempt; no allowOverlap needed.
  const fixed = setup(bonusRow({ landX: 280, ringX: 280 }));
  const summary = await fixed.run('check', fixed.file);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.landings[0], {
    node: 'coin', target: 'counterValue', tolerance: 0, t_ms: 800, centre: { x: 280, y: 391 }, targetBox: [221, 382, 291.6, 397], distance: 0,
  });
  assert.equal(summary.textClear.errors, 0);
  // The coin on its own target is what the landing declares, so it is not even a warning.
  assert.deepEqual(summary.warnings.filter(({ code }) => code?.startsWith('text-clear')), []);
  const passing = setup(bonusRow({ landX: 280, ringX: 280, allow: 'counterValue', extra: { clips: { run: { ...bonusRow({ landX: 0 }).clips.run, tracks: {
    ...bonusRow({ landX: 0 }).clips.run.tracks, coinX: [[0, 180], [200, 180], [500, 100], [800, 280, 'inOut']], coinY: [[0, 90], [200, 90], [500, 380], [800, 391]],
  } } } } }));
  const crossed = (await passing.run('check', passing.file)).warnings.find(({ code }) => code === 'text-clear-in-flight');
  assert.equal(crossed.node, 'coin (artboard.nodes[3].children[0])');
  assert.equal(crossed.text, 'counterLabel');
  assert.match(crossed.error, /passes [\d.]+ pt over the text "Daily bonus" \(counterLabel\) at \d+ ms in flight/);
});

test('an effect in place on another text fails until allowOverlap names the pair with a reason', async () => {
  const onLabel = setup(bonusRow({ landX: 280, ringX: 100 }));
  assert.match((await failure(() => onLabel.run('check', onLabel.file))).message, /^payoffRing .* rests [\d.]+ pt over the text "Daily bonus" \(counterLabel\)/);
  const declared = setup(bonusRow({ landX: 280, ringX: 100, allow: 'counterLabel' }));
  assert.equal((await declared.run('check', declared.file)).textClear.errors, 0);
});

test('a landing judges the end of travel, not the shrink into the target', async () => {
  const asset = bonusRow({ landX: 280, ringX: 280, allow: 'counterValue' });
  assert.deepEqual(travelChannels(asset.artboard.nodes, 'artboard.nodes[3]'), ['coinX', 'coinY']);
  // A tolerance widens the target; a time or marker moves the judgement.
  asset.landings = [{ node: 'coin', target: 'counterLabel', tolerance: 10 }];
  const { file, run } = setup(asset);
  assert.match((await failure(() => run('check', file))).message, /coin lands 142.8 pt outside counterLabel at 800 ms \(tolerance 10 pt\)/);
  asset.landings = [{ node: 'coin', target: 'counterValue', at: 500 }];
  const early = setup(asset);
  assert.match((await failure(() => early.run('check', early.file))).message, /coin lands [\d.]+ pt outside counterValue at 500 ms/);
});

test('a landing on a trigger ignores the snap back to idle and waits for the trigger', async () => {
  const asset = bonusRow({ landX: 280, ringX: 280, allow: 'counterValue' });
  asset.clips.idle = { ms: 0, tracks: {} };
  asset.machine = { schema: 'skac.machine/1', values: { claim: { type: 'trigger' } }, layers: [{
    name: 'bonus', entry: 'idle', states: { idle: { clip: 'idle' }, run: { clip: 'run', loop: 'once' } },
    transitions: [{ from: 'idle', to: 'run', when: [['claim']] }, { from: 'run', to: 'idle', exit_at: 1 }],
  }] };
  const { file, run } = setup(asset);
  const [landing] = (await run('check', file, '--commands=claim@0.1')).landings;
  assert.equal(landing.t_ms, 912); // the first sample after 100 + 800 ms
  assert.equal(landing.distance, 0);
  assert.match((await failure(() => run('check', file))).message, /coin never moves in the trace/);
});

test('ids, landings and allowOverlap are authoring-only: pack drops them and the runtime never sees them', async () => {
  const { file, run } = setup(bonusRow({ landX: 280, ringX: 280, allow: 'counterValue' }));
  const packed = readFileSync(run('pack', file).file, 'utf8');
  for (const key of ['"id"', '"landings"', '"allowOverlap"']) assert.ok(!packed.includes(key), `${key} left in the pack`);
  assert.equal(run('trace', file, '--trace=800').trace[0].channels.coinX, 280);
});

test('landings and allowances name real ids', async () => {
  const bad = async (asset, pattern) => {
    const { file, run } = setup(asset);
    await assert.rejects(async () => run('check', file), pattern);
  };
  await bad(bonusRow({ landX: 280, ringX: 280, extra: { landings: [{ node: 'coin', target: 'counter' }] } }), /landings\[0\]\.target: unknown node id "counter"/);
  await bad(bonusRow({ landX: 280, ringX: 280, extra: { landings: [{ node: 'coin', target: 'counterValue', tolerance: -1 }] } }), /landings\[0\]\.tolerance/);
  await bad(bonusRow({ landX: 280, ringX: 280, extra: { allowOverlap: [{ nodes: ['payoffRing', 'counterValue'] }] } }), /allowOverlap\[0\]\.reason: expected a reason/);
  const twice = bonusRow({ landX: 280, ringX: 280 });
  twice.artboard.nodes[2].children[0].id = 'coin';
  await bad(twice, /artboard\.nodes\[3\]\.id: duplicate node id "coin"/);
});

test('skac/text-clear follows the rule setting in skia-motion.json', async () => {
  const asset = bonusRow({ landX: 280, ringX: 280, landing: false });
  const warn = setup(asset, { rules: { 'skac/text-clear': 'warn' } });
  const summary = await warn.run('check', warn.file);
  assert.equal(summary.textClear.severity, 'warn');
  assert.ok(summary.warnings.some(({ code, node, text }) => code === 'text-clear' && node.startsWith('payoffRing') && text === 'counterValue'));
  const off = setup(asset, { rules: { 'skac/text-clear': 'off' } });
  assert.equal((await off.run('check', off.file)).textClear, undefined);
});

test('gaps: boxes are negative inside, edge distance beside, corner distance diagonally; circles by their edge', async () => {
  assert.equal(boxGap([0, 0, 10, 10], [12, 0, 20, 10]), 2);
  assert.equal(boxGap([0, 0, 10, 10], [5, 5, 20, 20]), -5);
  assert.equal(boxGap([0, 0, 10, 10], [13, 14, 20, 20]), 5);
  // A circle's box corner holds no ink: a circle of radius 10 at (0, 0) is 4.1 pt from a box at (10, 10), though their boxes touch.
  assert.equal(Number(circleGap({ x: 0, y: 0, r: 10 }, [10, 10, 20, 20]).toFixed(1)), 4.1);
  assert.equal(circleGap({ x: 0, y: 0, r: 10 }, [12, -5, 20, 5]), 2);
});

test('aim: true writes the flight\'s end keys onto the target, so the hand-keyed miss lands', async () => {
  const aimed = bonusRow({ landX: 27, ringX: 280, landing: false, extra: { landings: [{ node: 'coin', target: 'counterValue', aim: true }] } });
  const { file, run } = setup(aimed);
  const summary = await run('check', file);
  assert.equal(summary.ok, true);
  // The coin's end keys move it from beside the label onto the centre of the laid-out "+3 coins" ink (221 to 291.6 across, 382 to 397 down).
  assert.deepEqual(summary.aimed, [{ node: 'coin', target: 'counterValue', clip: 'run', t_ms: 800, moved: { x: 229.3, y: -1.5 }, offset: 0 }]);
  assert.deepEqual(summary.landings[0].centre, { x: 256.3, y: 389.5 });
  assert.equal(summary.landings[0].distance, 0);
  // Only the landing key and the hold after it move; the flight before keeps its hand-set path.
  const trace = await run('trace', file, '--trace=200,800');
  assert.equal(trace.trace[0].channels.coinX, 180);
  assert.ok(Math.abs(trace.trace[1].channels.coinX - 27) > 200);
});

test('aim refuses a flight it cannot solve: an unbound x, or a group above that rotates', async () => {
  const unbound = bonusRow({ landX: 27, ringX: 280, landing: false, extra: { landings: [{ node: 'counterLabel', target: 'counterValue', aim: true }] } });
  assert.match((await failure(() => setup(unbound).run('check', setup(unbound).file))).message, /landing counterLabel: aim needs its x and y bound to channels/);
  const rotated = bonusRow({ landX: 27, ringX: 280, landing: false, extra: { landings: [{ node: 'coin', target: 'counterValue', aim: true }] } });
  rotated.artboard.nodes[3] = { kind: 'group', x: 0, y: 0, rotation: 5, children: [rotated.artboard.nodes[3]] };
  const rotatedSetup = setup(rotated);
  assert.match((await failure(() => rotatedSetup.run('check', rotatedSetup.file))).message, /landing coin: a group above it rotates/);
});

test('aim on a target in a host font slot needs --font, and pack then ships the keys check aimed', async () => {
  const slotted = bonusRow({ landX: 27, ringX: 280, landing: false, extra: { landings: [{ node: 'coin', target: 'counterValue', aim: true }] } });
  slotted.fontSlots = { Counter: {} };
  slotted.artboard.nodes[1].fonts = ['Counter'];
  const { cwd, file, run } = setup(slotted);
  assert.match((await failure(() => run('check', file))).message,
    /landing coin: counterValue has text in font slot "Counter", so its ink cannot be measured/);
  const font = `--font=Counter=${new URL('../../templates/fonts/allo-1.0.3/Allo-Regular.otf', import.meta.url).pathname}`;
  const checked = await run('check', file, font);
  await run('pack', file, font, '--out=bonus.skmotion');
  const unpacked = await run('unpack', join(cwd, 'bonus.skmotion'), '--out=bonus.unpacked.json');
  const keys = JSON.parse(readFileSync(unpacked.file, 'utf8')).clips.run.tracks.coinX;
  // The packed end key puts the coin where check measured it landed: on the laid-out ink's centre.
  assert.ok(Math.abs(keys.at(-1)[1] - checked.landings[0].centre.x) < 0.01, `${keys.at(-1)[1]} against ${checked.landings[0].centre.x}`);
  assert.equal(checked.landings[0].distance, 0);
  // aim writes the keys where the flight stops; an `at` would judge another moment, so the pair is refused.
  const timed = setup(bonusRow({ landX: 27, ringX: 280, landing: false, extra: { landings: [{ node: 'coin', target: 'counterValue', aim: true, at: 600 }] } }));
  assert.match((await failure(() => timed.run('check', timed.file))).message, /aim writes the keys where the flight stops/);
});
