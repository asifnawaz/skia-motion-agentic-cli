import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../../src/cli.js';
import { boxGap, circleGap, travelChannels } from '../../src/asset-clear.js';
import { coinPng, tmp } from './helpers.js';

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
  // These tests judge the rules themselves, so check runs them strict (errors); the warn default has its own tests.
  return { cwd, file, run: (action, ...args) => execute(['asset', action, ...args, ...(action === 'check' ? ['--strict'] : [])], cwd) };
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

// A 20 pt "x3" at rest with one more piece drawn with it, judged by text-clear alone (no landings, no ids).
function badge(piece, { before = false, extra = {} } = {}) {
  const text = { kind: 'text', text: 'x3', x: 70, y: 70, width: 40, fontSize: 20, fill: '#1D2B2A', align: 'center' };
  return {
    schema: 'skac.asset/1', name: 'Badge', images: { coin: coinPng() },
    artboard: { width: 180, height: 180, nodes: [{ kind: 'group', x: 0, y: 0, children: before ? [piece, text] : [text, piece] }] },
    channels: {}, clips: { show: { ms: 0, tracks: {} } },
    machine: { schema: 'skac.machine/1', layers: [{ name: 'b', entry: 'show', states: { show: { clip: 'show' } } }] },
    ...extra,
  };
}

test('empty landings and allowOverlap are taken out like full ones, so the runtime never sees them', async () => {
  for (const extra of [{ landings: [] }, { allowOverlap: [] }, { landings: [], allowOverlap: [] }]) {
    const { file, run } = setup(badge({ kind: 'ellipse', x: 150, y: 150, width: 10, height: 10, fill: '#FFC25A' }, { extra }));
    const summary = await run('check', file);
    assert.equal(summary.ok, true, `${Object.keys(extra)}: ${summary.error}`);
  }
});

test('a glow bigger than the text over it is judged: only the text\'s own plate is its background', async () => {
  // A 60 x 60 glow centred on the text, drawn before or after it: it rests over the text.
  for (const before of [false, true]) {
    for (const glow of [
      { kind: 'ellipse', x: 60, y: 52, width: 60, height: 60, fill: '#FFC25A', opacity: 0.6 },
      { kind: 'roundRect', x: 60, y: 52, width: 60, height: 60, radius: 30, fill: '#FFC25A', feather: 8 },
    ]) {
      const { file, run } = setup(badge(glow, { before }));
      const error = await failure(() => run('check', file));
      assert.match(error.message, /rests [\d.]+ pt over the text "x3"/, `${glow.kind}${glow.feather ? ' feathered' : ''}, before: ${before}`);
    }
  }
  // A filled round rect drawn behind the text is its plate, and is not judged here (text-in-plate judges how the text sits on it).
  const plate = setup(badge({ kind: 'roundRect', x: 60, y: 62, width: 60, height: 40, radius: 20, fill: '#FFF6DC' }, { before: true }),
    { rules: { 'skac/text-in-plate': 'off' } });
  assert.equal((await plate.run('check', plate.file)).textClear.errors, 0);
  // A plate narrower than its text still fails.
  const narrow = setup(badge({ kind: 'roundRect', x: 84, y: 66, width: 12, height: 30, radius: 6, fill: '#FFF6DC' }, { before: true }),
    { rules: { 'skac/text-in-plate': 'off' } });
  assert.match((await failure(() => narrow.run('check', narrow.file))).message, /pt over the text "x3"/);
});

test('an icon beside its own label is left to text-in-plate; an icon over the text still fails', async () => {
  // The coin's drawn disc (its middle 8/12 of 18) ends about 2 pt before the text's ink, on the same row, centred on the optical band
  // of "x3" (half of it a digit, so half way from its x-height to its cap height).
  const near = setup(badge({ kind: 'image', image: 'coin', x: 64, y: 73.5, width: 18, height: 18 }));
  assert.equal((await near.run('check', near.file)).textClear.errors, 0);
  const over = setup(badge({ kind: 'image', image: 'coin', x: 82, y: 72, width: 18, height: 18 }));
  assert.match((await failure(() => over.run('check', over.file))).message, /pt over the text "x3"/);
});

test('a table row is laid out, not centred: a start-aligned label on a row background is judged down and by inset only', async () => {
  // A row background with a start-aligned label and a centred value in the right cell.
  const row = (labelAlign, labelY = 12) => ({
    schema: 'skac.asset/1', name: 'Summary',
    artboard: { width: 360, height: 120, nodes: [{ kind: 'group', x: 8, y: 40, children: [
      { kind: 'roundRect', x: 0, y: 0, width: 344, height: 44, radius: 10, fill: '#FFF8ED' },
      { kind: 'text', text: 'Correct', x: 16, y: labelY, width: 168, fontSize: 16, fill: '#002D2A', align: labelAlign },
      { kind: 'text', text: '5 of 5', x: 200, y: 11, width: 128, fontSize: 18, fill: '#002D2A', align: 'center' },
    ] }] },
    channels: {}, clips: { show: { ms: 0, tracks: {} } },
    machine: { schema: 'skac.machine/1', layers: [{ name: 's', entry: 'show', states: { show: { clip: 'show' } } }] },
  });
  const laidOut = setup(row('start'));
  const summary = await laidOut.run('check', laidOut.file);
  assert.equal(summary.ok, true, summary.error);
  assert.equal(summary.textClear.errors, 0, 'the row background is the texts\' background for text-clear');
  // The same texts both centred are content on a plate, and sit far off its centre.
  const centred = setup(row('center'));
  assert.match((await failure(() => centred.run('check', centred.file))).message, /"Correct" "5 of 5" on artboard\.nodes\[0\]\.children\[0\] is [\d.]+ pt off centre across/);
  // A laid-out label is still judged down: moved 6 pt low, it pulls the row's content off centre.
  const low = setup(row('start', 18));
  assert.match((await failure(() => low.run('check', low.file))).message, /off centre down/);
});

test('a pill whose text gives no align is judged across: 3 pt off centre fails', async () => {
  const pill = (dx) => ({
    schema: 'skac.asset/1', name: 'Pill',
    artboard: { width: 200, height: 100, nodes: [{ kind: 'group', x: 40, y: 30, children: [
      { kind: 'roundRect', x: 0, y: 0, width: 120, height: 40, radius: 20, fill: '#FFF6DC' },
      { kind: 'text', text: '+12', x: 30 + dx, y: 9, width: 60, fontSize: 20, fill: '#1D2B2A', fontFeatures: [{ name: 'tnum', value: 1 }] },
    ] }] },
    channels: {}, clips: { show: { ms: 0, tracks: {} } },
    machine: { schema: 'skac.machine/1', layers: [{ name: 'p', entry: 'show', states: { show: { clip: 'show' } } }] },
  });
  // Find where the ink sits centred, then move it 3 pt right: with no align the text is not laid out on a row, so it fails across.
  const probe = setup(pill(0));
  const reply = await probe.run('check', probe.file).catch((error) => error.extra);
  const off = /([\d.]+) pt off centre across.*?padding ([\d.]+) pt left, ([\d.]+) pt right/.exec(reply.problems?.map(({ error }) => error).join(' ') ?? '');
  const centre = off ? (Number(off[3]) - Number(off[2])) / 2 : 0;
  const centred = setup(pill(centre));
  assert.equal((await centred.run('check', centred.file).catch((error) => error.extra)).textInPlate.errors, 0, 'centred, it passes');
  const moved = setup(pill(centre + 3));
  assert.match((await failure(() => moved.run('check', moved.file))).message, /"\+12" on artboard\.nodes\[0\]\.children\[0\] is 3 pt off centre across/);
});

// Two ordinary assets the text rules flag: a card whose background is a full-size round rect with two left-placed lines, and a static
// ellipse behind a centred title. Without --strict they are warnings and check passes, as it did before the rules; strict, they fail.
const plainCard = () => ({
  schema: 'skac.asset/1', name: 'Card', artboard: { width: 320, height: 140, nodes: [
    { kind: 'roundRect', x: 0, y: 0, width: 320, height: 140, radius: 16, fill: '#FFFFFF' },
    { kind: 'text', text: 'Daily streak', x: 20, y: 24, width: 200, fontSize: 20, fill: '#1A1A1A' },
    { kind: 'text', text: 'Keep going', x: 20, y: 60, width: 200, fontSize: 14, fill: '#555555' },
  ] },
  channels: { glow: 0 }, clips: { idle: { ms: 300, tracks: { glow: [[0, 0], [300, 1]] } } },
  machine: { schema: 'skac.machine/1', layers: [{ name: 'card', entry: 'idle', states: { idle: { clip: 'idle', loop: 'once' } } }] },
});
const haloTitle = () => ({
  schema: 'skac.asset/1', name: 'Halo', artboard: { width: 320, height: 200, nodes: [
    { kind: 'ellipse', x: 60, y: 50, width: 200, height: 100, fill: '#FFE7A8' },
    { kind: 'text', text: 'Level up', x: 60, y: 86, width: 200, fontSize: 24, align: 'center', fill: '#1A1A1A' },
  ] },
  channels: { glow: 0 }, clips: { idle: { ms: 300, tracks: { glow: [[0, 0], [300, 1]] } } },
  machine: { schema: 'skac.machine/1', layers: [{ name: 'halo', entry: 'idle', states: { idle: { clip: 'idle', loop: 'once' } } }] },
});

test('the text rules warn by default: a plain card and a halo behind a title pass check with warnings', async () => {
  for (const [asset, rule] of [[plainCard(), 'skac/text-in-plate'], [haloTitle(), 'skac/text-clear']]) {
    const cwd = tmp('asset-default-');
    const file = join(cwd, 'plain.motion.json');
    writeFileSync(file, JSON.stringify(asset));
    const summary = await execute(['asset', 'check', file], cwd);
    assert.equal(summary.ok, true, asset.name);
    assert.ok(summary.warnings.some((warning) => (warning.rule ?? warning.check) === rule), `${asset.name}: ${JSON.stringify(summary.warnings)}`);
  }
});

test('the text rules are errors under --strict, and under "checks": "strict" in the asset', async () => {
  for (const [asset, rule] of [[plainCard(), 'skac/text-in-plate'], [haloTitle(), 'skac/text-clear']]) {
    const cwd = tmp('asset-strict-');
    const file = join(cwd, 'plain.motion.json');
    writeFileSync(file, JSON.stringify(asset));
    const flagged = await failure(() => execute(['asset', 'check', file, '--strict'], cwd));
    assert.ok(flagged.extra.problems.some(({ check }) => check === rule), `${asset.name}: ${flagged.message}`);
    writeFileSync(file, JSON.stringify({ ...asset, checks: 'strict' }));
    const marked = await failure(() => execute(['asset', 'check', file], cwd));
    assert.ok(marked.extra.problems.some(({ check }) => check === rule), `${asset.name}: ${marked.message}`);
  }
  // The field is authoring-only: pack takes it out, and it takes only "strict".
  const cwd = tmp('asset-strict-');
  const file = join(cwd, 'plain.motion.json');
  writeFileSync(file, JSON.stringify({ ...haloTitle(), checks: 'strict', allowOverlap: [{ nodes: ['halo', 'title'], reason: 'the halo sits behind the title' }] }).replace('"kind":"ellipse"', '"id":"halo","kind":"ellipse"').replace('"kind":"text"', '"id":"title","kind":"text"'));
  await execute(['asset', 'pack', file, '--out=plain.skmotion'], cwd);
  assert.equal('checks' in JSON.parse(readFileSync(join(cwd, 'plain.skmotion'), 'utf8')), false);
  writeFileSync(file, JSON.stringify({ ...haloTitle(), checks: 'loose' }));
  assert.match((await failure(() => execute(['asset', 'check', file], cwd))).message, /checks/);
});

test('the asset templates pass check --strict, so an asset started from one starts clean', async () => {
  for (const name of ['game-hud', 'versus-hud', 'sprout', 'reward-counter']) {
    const cwd = tmp('asset-template-');
    const file = join(cwd, `${name}.motion.json`);
    writeFileSync(file, readFileSync(new URL(`../../templates/assets/${name}.json`, import.meta.url), 'utf8'));
    const summary = await execute(['asset', 'check', file, '--strict'], cwd);
    assert.equal(summary.ok, true, name);
  }
});
