import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../../src/cli.js';
import { loadCanvasKit } from '../../src/asset-text-layout.js';
import { coinPng, tmp } from './helpers.js';

// A coin counter as a row: the coin and the count placed by their ink, 4 pt apart, on a pill sized for "+888". Nothing is placed by hand.
function counter({ value = '+3', direction, align = 'center', stroke = true, extra = {} } = {}) {
  return {
    schema: 'skac.asset/1', name: 'CoinCounter', images: { coin: coinPng() },
    artboard: { width: 180, height: 120, nodes: [{ id: 'counter', kind: 'group', x: 90, y: 60,
      row: { gap: 4, align, ...(direction && { direction }),
        plate: { padding: [10, 6], fill: '#FFF6DC', ...(stroke && { stroke: { color: '#E0C27A', width: 1.5 } }), widest: '+888' } },
      children: [
        { id: 'coin', kind: 'image', image: 'coin', x: 0, y: 0, width: 18, height: 18 },
        { id: 'count', kind: 'text', text: { value: 'count' }, x: 0, y: 0, width: 80, fontSize: 20, fill: '#1D2B2A', fontFeatures: [{ name: 'tnum', value: 1 }] },
      ] }] },
    channels: {}, clips: { show: { ms: 0, tracks: {} } },
    machine: { schema: 'skac.machine/1', values: { count: { type: 'string', default: value } },
      layers: [{ name: 'counter', entry: 'show', states: { show: { clip: 'show' } } }] },
    ...extra,
  };
}

const setup = (asset) => {
  const cwd = tmp('asset-row-');
  const file = join(cwd, 'counter.motion.json');
  writeFileSync(file, JSON.stringify(asset));
  // These tests judge the rules themselves, so check runs them strict (errors); the warn default has its own tests.
  return { cwd, file, run: (action, ...args) => execute(['asset', action, ...args, ...(action === 'check' ? ['--strict'] : [])], cwd) };
};

async function inkOf(file, within = [0, 0, Infinity, Infinity]) {
  const kit = await loadCanvasKit();
  const image = kit.MakeImageFromEncoded(readFileSync(file));
  const width = image.width();
  const height = image.height();
  const px = image.readPixels(0, 0, { width, height, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
  // The count's ink and the coin's, each as a box in artboard points (the frame is drawn at 4x). An edge pixel counts when it is at least
  // half ink over the plate (#FFF6DC): red under 142 for the count (#1D2B2A), blue under 140 with red over 200 for the coin (230, 180, 60).
  // Frames drawn here have no plate stroke, whose gold would match the coin.
  const box = (match) => {
    let b;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (x < within[0] * 4 || y < within[1] * 4 || x >= within[2] * 4 || y >= within[3] * 4) continue;
      const i = (y * width + x) * 4;
      if (px[i + 3] === 255 && match(px[i], px[i + 1], px[i + 2])) b = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x + 1), Math.max(b[3], y + 1)] : [x, y, x + 1, y + 1];
    }
    return b.map((v) => v / 4);
  };
  return { count: box((r) => r < 142), coin: box((r, _g, b) => r > 200 && b < 140) };
}

test('row: asset check passes text-in-plate for every value, with no hand placement', async () => {
  for (const value of ['+3', '+12', '+888']) {
    const { file, run } = setup(counter({ value }));
    const summary = await run('check', file);
    assert.equal(summary.ok, true, `${value}: ${summary.error}`);
    assert.deepEqual(summary.textInPlate.unmeasured, [], `${value}: the count is measured`);
  }
});

test('row: the plate is judged: aligned to the start, a short value sits off centre in a plate sized for the widest', async () => {
  const { file, run } = setup(counter({ value: '+3', align: 'start' }));
  const summary = await run('check', file).catch((error) => error.details ?? { ok: false, error: error.message });
  assert.equal(summary.ok, false);
  assert.match(summary.error, /"\+3" on counter \(artboard.nodes\[0\].children\[plate\]\) is [0-9.]+ pt off centre across/);
});

test('row: a shape the row places is content on the plate, like an image', async () => {
  const asset = counter();
  asset.artboard.nodes[0].children[0] = { id: 'coin', kind: 'ellipse', x: 0, y: 0, width: 18, height: 18, fill: '#E6B43C' };
  for (const value of ['+3', '+888']) {
    asset.machine.values.count.default = value;
    const { file, run } = setup(asset);
    const summary = await run('check', file);
    assert.equal(summary.ok, true, `${value}: ${summary.error}`);
  }
});

test('row: a plate behind a bound text needs widest', async () => {
  const asset = counter();
  delete asset.artboard.nodes[0].row.plate.widest;
  const { file, run } = setup(asset);
  await assert.rejects(async () => run('check', file), /plate\.widest: a plate behind a bound text needs widest/);
});

test('row: a rolling count is placed by the value it shows, at rest and part way', async () => {
  const asset = counter({ stroke: false });
  const count = asset.artboard.nodes[0].children[1];
  count.roll = { progress: 'turn', from: 'was' };
  asset.channels = { turn: 0 };
  asset.clips.show = { ms: 400, tracks: { turn: [[0, 0], [400, 1]] } };
  asset.machine.values.was = { type: 'string', default: '+3' };
  asset.machine.values.count.default = '+12';
  const { file, run } = setup(asset);
  const summary = await run('check', file);
  assert.equal(summary.ok, true, summary.error);
  // At the start the count shows "+3": the coin is 4 pt from its ink and the pair is centred, as for a still "+3".
  const start = await inkOf((await run('frame', file, '--trace=0', '--size=720x480', '--out=roll0.png')).file);
  const plain = setup(counter({ value: '+3', stroke: false }));
  const still = await inkOf((await plain.run('frame', plain.file, '--trace=0', '--size=720x480', '--out=still.png')).file);
  assert.ok(Math.abs(start.coin[0] - still.coin[0]) <= 0.25, `coin ${start.coin[0]} vs ${still.coin[0]}`);
  const end = await inkOf((await run('frame', file, '--trace=400', '--size=720x480', '--out=roll1.png')).file);
  assert.ok(end.coin[0] < start.coin[0] - 2, `the coin moves left for "+12": ${start.coin[0]} -> ${end.coin[0]}`);
  // While it rolls the row moves the count by the width it has opened, so the coin keeps its 4 pt from the count's ink and the pair
  // stays centred on the group's x throughout, not only at rest.
  for (const t of [100, 150, 175, 200, 300]) {
    const { count, coin } = await inkOf((await run('frame', file, `--trace=${t}`, '--size=720x480', `--out=roll-${t}.png`)).file);
    assert.ok(Math.abs(count[0] - coin[2] - 4) <= 1, `gap at ${t} ms: ${count[0] - coin[2]}`);
    assert.ok(Math.abs((coin[0] + count[2]) / 2 - 90) <= 1, `centre at ${t} ms: ${(coin[0] + count[2]) / 2}`);
  }
  assert.ok(Math.abs(end.count[0] - end.coin[2] - 4) <= 1, `gap at rest ${end.count[0] - end.coin[2]}`);
  assert.ok(Math.abs((end.coin[0] + end.count[2]) / 2 - 90) <= 0.5, `centre at rest ${(end.coin[0] + end.count[2]) / 2}`);
});

test('row: the phone draw (CanvasKit) puts the ink where check measures it: gap 4, coin on the band, centred on the pill', async () => {
  for (const value of ['+3', '+12']) {
    // No stroke here: its gold would read as the coin's.
    const { file, run } = setup(counter({ value, stroke: false }));
    const frame = await run('frame', file, '--trace=0', '--size=720x480', `--out=${value}.png`);
    const { count, coin } = await inkOf(frame.file);
    // The coin's drawn disc is its middle 8/12; the gap from it to the count's ink is the row's 4 pt. Drawn edges read up to 0.75 pt
    // inside the measured bounds (a scaled pixel disc, glyph outlines at half coverage), so this holds to the checks' 1 pt.
    assert.ok(Math.abs(count[0] - coin[2] - 4) <= 1, `${value}: ink gap ${count[0] - coin[2]}`);
    // The pair is centred on the group's x (90).
    assert.ok(Math.abs((coin[0] + count[2]) / 2 - 90) <= 0.5, `${value}: centre ${(coin[0] + count[2]) / 2}`);
    // The coin's centre is on the count's cap band middle, which sits on the group's y (60).
    assert.ok(Math.abs((coin[1] + coin[3]) / 2 - 60) <= 0.5, `${value}: coin centre ${(coin[1] + coin[3]) / 2}`);
  }
});

test('row: right to left puts the first child on the right, and pack writes the coin\'s ink', async () => {
  const { cwd, file, run } = setup(counter({ direction: 'rtl', stroke: false }));
  const frame = await run('frame', file, '--trace=0', '--size=720x480', '--out=rtl.png');
  const { count, coin } = await inkOf(frame.file);
  assert.ok(coin[0] > count[2], 'the coin is right of the count');
  await run('pack', file, '--out=counter.skmotion');
  const packed = JSON.parse(readFileSync(join(cwd, 'counter.skmotion'), 'utf8'));
  assert.deepEqual(packed.imageInk, { coin: [0.1667, 0.1667, 0.8333, 0.8333] });
  assert.equal(packed.artboard.nodes[0].row.plate.widest, '+888');
});

test('row: a platform-font text in a row is refused', async () => {
  const asset = counter();
  asset.artboard.nodes[0].children[1].fonts = [];
  const { file, run } = setup(asset);
  await assert.rejects(async () => run('check', file), /a text in a row needs an embedded font or a font slot/);
});

test('row: a text with a character its fonts lack warns text-layout-fallback, naming the text', async () => {
  const { file, run } = setup(counter({ value: '+3 \u{1F525}' }));
  const summary = await run('check', file).catch((error) => error.extra);
  const warning = summary.warnings.find(({ code }) => code === 'text-layout-fallback');
  assert.ok(warning, JSON.stringify(summary.warnings.map(({ code }) => code)));
  assert.equal(warning.id, 'count');
  assert.match(warning.error, /U\+1F525/);
});

test('row: a row on a mesh pin gets its image ink packed and its widest sample measured, as on a group', async () => {
  const asset = counter({ stroke: false });
  const row = asset.artboard.nodes[0];
  asset.artboard.nodes = [{
    // The mesh sits in the corner, clear of the row; its pin is its first vertex, and the row hangs from it at (90, 60).
    kind: 'mesh', image: 'coin', vertices: [[150, 100, 0, 0], [170, 100, 1, 0], [150, 115, 0, 1], [170, 115, 1, 1]], indices: [0, 1, 2, 1, 3, 2],
    pins: { badge: { triangle: 0, weights: [1, 0, 0], children: [{ ...row, x: -60, y: -40 }] } },
  }, {
    // A text off the pin, inside the box of the mesh and its row but 30 pt from the mesh's own surface: the mesh is judged by its surface.
    id: 'hint', kind: 'text', text: 'Tap', x: 100, y: 94, width: 20, fontSize: 12, fill: '#1D2B2A',
  }];
  const { cwd, file, run } = setup(asset);
  const summary = await run('check', file);
  assert.equal(summary.ok, true, summary.error);
  assert.deepEqual(summary.textInPlate.unmeasured, []);
  assert.equal(summary.textClear.textBoxes.declared, 0, 'the widest sample is laid out, not its declared box');
  // The row on the pin is drawn like a row in a group: the coin placed by its ink, 4 pt from the count's (above the mesh and the hint).
  const { count, coin } = await inkOf((await run('frame', file, '--trace=0', '--size=720x480', '--out=pinned.png')).file, [0, 0, 145, 85]);
  assert.ok(Math.abs(count[0] - coin[2] - 4) <= 1, `gap ${count[0] - coin[2]}`);
  await run('pack', file, '--out=pinned.skmotion');
  const packed = JSON.parse(readFileSync(join(cwd, 'pinned.skmotion'), 'utf8'));
  assert.deepEqual(packed.imageInk, { coin: [0.1667, 0.1667, 0.8333, 0.8333] });
});
