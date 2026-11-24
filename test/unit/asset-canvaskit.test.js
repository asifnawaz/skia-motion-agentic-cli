import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../../src/cli.js';
import { loadCanvasKit } from '../../src/asset-text-layout.js';
import { tmp } from './helpers.js';

// A badge: a plate, a soft glow behind a dot (feather, which the SVG preview only approximates) and a label in the bundled face.
const badge = {
  schema: 'skac.asset/1', name: 'Badge',
  artboard: { width: 120, height: 60, nodes: [
    { kind: 'roundRect', x: 4, y: 4, width: 112, height: 52, radius: 12, fill: '#1D2B2A' },
    { kind: 'ellipse', x: 10, y: 14, width: 32, height: 32, fill: '#F5C542', feather: 'glow' },
    { kind: 'ellipse', x: 18, y: 22, width: 16, height: 16, fill: '#F5C542' },
    { kind: 'text', text: 'Badge', x: 50, y: 18, width: 64, fontSize: 18, fill: '#FFFFFF' },
  ] },
  channels: { glow: 0 },
  clips: { idle: { ms: 0, tracks: {} }, shine: { ms: 400, tracks: { glow: [[0, 0], [400, 6]] } } },
  machine: { schema: 'skac.machine/1', values: { shine: { type: 'trigger' } }, layers: [{ name: 'badge', entry: 'idle',
    states: { idle: { clip: 'idle' }, shine: { clip: 'shine', loop: 'once' } }, transitions: [{ from: 'idle', to: 'shine', when: [['shine']] }] }] },
};

async function pixels(file) {
  const kit = await loadCanvasKit();
  const image = kit.MakeImageFromEncoded(readFileSync(file));
  const width = image.width();
  const data = image.readPixels(0, 0, { width, height: image.height(), colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
  return { width, height: image.height(), at: (x, y) => Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4)) };
}

test('frame --out=*.png draws through the app\'s own draw code on CanvasKit', async () => {
  const cwd = tmp('asset-canvaskit-');
  const file = join(cwd, 'badge.motion.json');
  writeFileSync(file, JSON.stringify(badge));
  const rest = await execute(['asset', 'frame', file, '--trace=0', '--size=240x120', '--out=rest.png', '--background=#FFFFFF'], cwd);
  assert.equal(rest.renderer, 'canvaskit');
  const still = await pixels(rest.file);
  assert.deepEqual([still.width, still.height], [240, 120]);
  assert.deepEqual(still.at(2, 2), [255, 255, 255, 255], 'the background fills outside the plate');
  assert.deepEqual(still.at(52, 60), [245, 197, 66, 255], 'the dot draws in its colour at 2x');
  // The label's ink: some pixel in its box is near white.
  let label = 0;
  for (let x = 100; x < 220; x++) for (let y = 36; y < 76; y++) if (still.at(x, y)[0] > 200) label++;
  assert.ok(label > 100, `the label draws in the bundled face (${label} light pixels)`);
  // Half way through the shine the glow is a real blur: just outside the glow ellipse's edge the plate is lit, not hard-edged.
  const lit = await pixels((await execute(['asset', 'frame', file, '--trace=200', '--commands=shine@0', '--size=240x120', '--out=lit.png'], cwd)).file);
  const unlit = still.at(14, 60);
  const glowing = lit.at(14, 60);
  assert.ok(glowing[0] > unlit[0] + 20, `the feather spreads the glow past its edge (${unlit} -> ${glowing})`);
  // Without .png the still stays an SVG.
  assert.match(readFileSync((await execute(['asset', 'frame', file, '--trace=0', '--out=rest.svg'], cwd)).file, 'utf8'), /^<svg/);
});

test('frame --out=*.png draws a host font slot with --font', async () => {
  const cwd = tmp('asset-canvaskit-slot-');
  const file = join(cwd, 'badge.motion.json');
  const slotted = structuredClone(badge);
  slotted.fontSlots = { Label: {} };
  slotted.artboard.nodes[3].fonts = ['Label'];
  writeFileSync(file, JSON.stringify(slotted));
  const font = new URL('../../templates/fonts/allo-1.0.3/Allo-Regular.otf', import.meta.url).pathname;
  const result = await execute(['asset', 'frame', file, '--trace=0', '--size=240x120', '--out=slot.png', `--font=Label=${font}`], cwd);
  const still = await pixels(result.file);
  let label = 0;
  for (let x = 100; x < 220; x++) for (let y = 36; y < 76; y++) if (still.at(x, y)[0] > 200) label++;
  assert.ok(label > 100, `the slot's face draws the label (${label} light pixels)`);
});

test('a rolling number at rest draws exactly as its plain text with tabular figures, left to right and right to left', async () => {
  const cwd = tmp('asset-canvaskit-roll-');
  const font = new URL('../../templates/fonts/allo-1.0.3/Allo-Regular.otf', import.meta.url).pathname;
  const draw = async (name, node, values, turn) => {
    const file = join(cwd, `${name}.motion.json`);
    writeFileSync(file, JSON.stringify({
      schema: 'skac.asset/1', name: 'Roll', fontSlots: { Face: {} },
      artboard: { width: 200, height: 60, nodes: [{ kind: 'text', x: 20, y: 12, width: 160, fontSize: 28, fill: '#000000', align: 'center', fonts: ['Face'], ...node }] },
      channels: { turn }, clips: { idle: { ms: 0, tracks: {} } },
      machine: { schema: 'skac.machine/1', values, layers: [{ name: 'l', entry: 'idle', states: { idle: { clip: 'idle' } } }] },
    }));
    return pixels((await execute(['asset', 'frame', file, '--trace=0', '--size=800x240', `--out=${name}.png`, `--font=Face=${font}`], cwd)).file);
  };
  const same = (a, b) => {
    let differ = 0;
    for (let y = 0; y < 240; y++) for (let x = 0; x < 800; x++) if (Math.abs(a.at(x, y)[3] - b.at(x, y)[3]) > 10) differ++;
    return differ;
  };
  for (const [direction, from, to] of [['ltr', '+98', '+102'], ['rtl', '+٩٨%', '+١٠٢%']]) {
    for (const [turn, shown] of [[0, from], [1, to]]) {
      const roll = await draw(`roll-${direction}-${turn}`, { text: { value: 'to' }, roll: { progress: 'turn', from: 'from' }, direction },
        { from: { type: 'string', default: from }, to: { type: 'string', default: to } }, turn);
      const plain = await draw(`plain-${direction}-${turn}`, { text: shown, direction, fontFeatures: [{ name: 'tnum', value: 1 }] }, {}, 0);
      assert.equal(same(roll, plain), 0, `${direction} ${JSON.stringify(shown)} at rest`);
    }
  }
});
