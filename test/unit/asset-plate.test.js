import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { execute } from '../../src/cli.js';
import { tmp } from './helpers.js';

// A 12 x 12 PNG: a solid disc of radius 4 in the middle, clear around it, so the drawn part is the middle 8 x 8.
function coinPng() {
  const size = 12;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = y * (size * 4 + 1) + 1 + x * 4;
      const inside = Math.hypot(x + 0.5 - 6, y + 0.5 - 6) <= 4;
      raw.set(inside ? [230, 180, 60, 255] : [0, 0, 0, 0], at);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// A coin counter pill: a border plate, a fill plate, a coin icon, a "+" and a count. `layout` places the pieces inside the pill's group.
function counter({ coin, plus, count, plate = { w: 78, h: 34 }, tracks = {}, channels = {}, extra = {} }) {
  const pill = { kind: 'group', x: 90, y: 120, children: [
    { kind: 'roundRect', x: -(plate.w + 3) / 2, y: -(plate.h + 3) / 2, width: plate.w + 3, height: plate.h + 3, radius: (plate.h + 3) / 2, fill: '#E0C27A' },
    { id: 'pill', kind: 'roundRect', x: typeof plate.w === 'string' ? 'plateX' : -plate.w / 2, y: -plate.h / 2, width: plate.w, height: plate.h, radius: plate.h / 2, fill: '#FFF6DC' },
    { id: 'coin', kind: 'image', image: 'coin', ...coin },
    { id: 'plus', kind: 'text', text: '+', width: 20, fontSize: 20, fill: '#1D2B2A', align: 'center', ...plus },
    { id: 'count', kind: 'text', text: { value: 'count' }, width: 14, fontSize: 20, fill: '#1D2B2A', align: 'center', fontFeatures: [{ name: 'tnum', value: 1 }], ...count },
  ] };
  return {
    schema: 'skac.asset/1', name: 'CoinCounter', images: { coin: coinPng() },
    artboard: { width: 180, height: 240, nodes: [pill] }, channels,
    clips: { show: { ms: 900, tracks } },
    machine: { schema: 'skac.machine/1', values: { count: { type: 'string', default: '3' } },
      layers: [{ name: 'counter', entry: 'show', states: { show: { clip: 'show', loop: 'once' } } }] },
    ...extra,
  };
}

// The pieces where a hand-placed pill put them: the coin's box centred on the text boxes, the "+" and the count side by side.
const RED = { coin: { x: -24.8, y: -9, width: 18, height: 18 }, plus: { x: -5.8, y: -7.25 }, count: { x: 12.95, y: -8.25 } };

// The same pieces placed from the measured ink: the content group centred both ways, the coin's drawn part on the cap-height middle.
const GREEN = { coin: { x: -24.5, y: -8.6, width: 18, height: 18 }, plus: { x: -9.95, y: -11.1 }, count: { x: 8.8, y: -11.1 } };

const check = async (asset, ...args) => {
  const cwd = tmp('asset-plate-');
  const file = join(cwd, 'counter.motion.json');
  writeFileSync(file, JSON.stringify(asset));
  try {
    return await execute(['asset', 'check', file, ...args], cwd);
  } catch (error) {
    return { ok: false, error: error.message, ...error.extra };
  }
};
const plateErrors = (result) => (result.problems ?? []).filter(({ check: id }) => id === 'skac/text-in-plate').map(({ error }) => error);

test('a hand-placed counter pill fails text-in-plate: off centre, and the coin off the text\'s optical centre', async () => {
  const errors = plateErrors(await check(counter(RED)));
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.match(errors[0], /^"\+" "3" on pill is [\d.]+ pt off centre across at \d+ ms \(padding [\d.]+ pt left, [\d.]+ pt right\)/);
  assert.match(errors[1], /^"\+" "3" on pill is [\d.]+ pt off centre down at \d+ ms \(optical band/);
  assert.match(errors[2], /^coin sits [\d.]+ pt above the optical centre of "\+" \(plus\) at \d+ ms; the most is 1 pt$/);
});

test('the same pill laid out from the ink passes: content centred, coin on the cap-height middle', async () => {
  const green = await check(counter(GREEN));
  assert.deepEqual(plateErrors(green), []);
  assert.equal(green.ok, true, green.error);
  assert.deepEqual(green.textInPlate, { severity: 'error', errors: 0, warnings: 0, unmeasured: [] });
});

test('content closer than 4 pt to the plate edge fails', async () => {
  const tight = plateErrors(await check(counter({
    ...GREEN, plate: { w: 50, h: 34 },
  })));
  assert.ok(tight.some((error) => /^"\+" "3" on pill comes [\d.-]+ pt from the plate's edge at \d+ ms; the least is 4 pt$/.test(error)), tight.join('\n'));
});

test('a plate that resizes when the value changes fails', async () => {
  const asset = counter({
    ...GREEN,
    channels: { plateW: 78, plateX: -39 },
    tracks: { plateW: [[0, 78], [400, 78], [450, 96]], plateX: [[0, -39], [400, -39], [450, -48]] },
  });
  asset.artboard.nodes[0].children[1].width = 'plateW';
  asset.artboard.nodes[0].children[1].x = 'plateX';
  // The border plate stays put, so name the fill plate the texts sit on.
  for (const node of asset.artboard.nodes[0].children) if (node.kind === 'text') node.plate = 'pill';
  const errors = plateErrors(await check(asset, '--commands=count="12"@0.42'));
  assert.ok(errors.some((error) => /^pill changes size from 78 x 34 pt \("\+\|3", \d+ ms\) to [\d.]+ x 34 pt \("\+\|12", \d+ ms\); the most is 1 pt$/.test(error)), errors.join('\n'));
});

test('the coin-to-text ink gap must hold while the value changes', async () => {
  // One centred text "+3" beside the coin: when it becomes "+12" its ink starts further left, so the gap shrinks.
  const row = {
    schema: 'skac.asset/1', name: 'CoinRow', images: { coin: coinPng() },
    artboard: { width: 200, height: 80, nodes: [
      { id: 'coin', kind: 'image', image: 'coin', x: 20, y: 18.8, width: 18, height: 18 },
      { id: 'amount', kind: 'text', text: { value: 'amount' }, x: 38, y: 16.3, width: 34, fontSize: 20, fill: '#1D2B2A', align: 'center' },
    ] },
    channels: {}, clips: { show: { ms: 900, tracks: {} } },
    machine: { schema: 'skac.machine/1', values: { amount: { type: 'string', default: '+3' } },
      layers: [{ name: 'row', entry: 'show', states: { show: { clip: 'show', loop: 'once' } } }] },
  };
  const centred = plateErrors(await check(row, '--commands=amount="+12"@0.45'));
  assert.ok(centred.some((error) => /^the ink gap from coin to amount changes from [\d.]+ pt \("\+12", \d+ ms\) to [\d.]+ pt \("\+3", \d+ ms\)/.test(error)), centred.join('\n'));
  row.artboard.nodes[1].align = 'start';
  row.artboard.nodes[1].x = 40;
  const started = plateErrors(await check(row, '--commands=amount="+12"@0.45'));
  assert.ok(!started.some((error) => error.includes('ink gap')), started.join('\n'));
});

test('a text with no laid-out font is listed as unmeasured, not judged', async () => {
  const asset = counter(RED);
  for (const node of asset.artboard.nodes[0].children) if (node.kind === 'text') node.fonts = [];
  const result = await check(asset);
  assert.deepEqual(plateErrors(result), []);
  assert.deepEqual(result.textInPlate.unmeasured.sort(), ['count', 'plus']);
});
