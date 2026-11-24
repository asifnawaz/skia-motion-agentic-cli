import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { FILE, render } from '../../scripts/unicode-tables.js';
import { loadModules } from './helpers.js';

const { I, U } = loadModules({ I: './runtime/asset-ink.ts', U: './runtime/asset-unicode.ts' });

test('textCase: lowercase only, caseless scripts, and everything else read on the cap height', () => {
  assert.equal(I.textCase('coins'), 'lower');
  assert.equal(I.textCase('Coins'), 'cased');
  assert.equal(I.textCase('+3'), 'cased');
  assert.equal(I.textCase('x3'), 'cased', 'a digit puts lowercase on the cap height');
  assert.equal(I.textCase('+۱۲'), 'cased', 'Extended Arabic-Indic digits are digits');
  assert.equal(I.textCase('سکے'), 'caseless');
  assert.equal(I.textCase('۱۲ سکے'), 'caseless');
  assert.equal(I.textCase('٪،'), 'cased', 'Arabic punctuation has no letters');
  assert.equal(I.textCase('ßä'), 'lower');
  assert.equal(I.textCase('ĸ'), 'lower', 'a lowercase letter with no capital is still lowercase');
  // Signs from outside Latin-1 have no letters, so a count with them reads on the cap height like "+3".
  for (const text of ['−3', '€12', '12–15', '+3…', '“3”', '3\u202f%', '\u200f+3']) assert.equal(I.textCase(text), 'cased', text);
  assert.equal(I.textCase('١٢'), 'cased', 'Arabic-Indic digits are digits');
  assert.equal(I.textCase('三'), 'caseless');
});

test('the Unicode tables are ascending pairs, and match the Unicode data they were generated from (npm run unicode:tables)', () => {
  const file = readFileSync(FILE, 'utf8');
  for (const name of ['CASELESS_LETTERS', 'LOWERCASE_LETTERS', 'UPPERCASE_LETTERS']) {
    const table = U[name];
    assert.equal(table.length % 2, 0, name);
    for (let i = 1; i < table.length; i++) assert.ok(table[i] >= table[i - 1] + (i % 2 ? 0 : 1), `${name} at ${i}`);
  }
  // The file names the Unicode version it came from; a Node with that version regenerates it byte for byte (CI's older Nodes carry
  // older Unicode data, so they check the shape above only).
  const version = /from Unicode ([\d.]+)/.exec(file)?.[1];
  if (version === process.versions.unicode) assert.equal(file, render());
});

test('rowItems: a bound text\'s band comes from the widest sample, so a caseless count neither bobs nor resizes its plate', () => {
  // Caseless ink bands: "۳" is short (6..18), the widest sample "۸۸۸" tall (2..20).
  const inks = { shown: { box: [0, 6, 8, 18], band: [6, 18] }, wide: { box: [0, 2, 30, 20], band: [2, 20] } };
  const read = (value) => (typeof value === 'number' ? value : 0);
  const children = [{ kind: 'text', x: 0, y: 0, text: { value: 'count' } }];
  const { items, widest, bands } = I.rowItems(children, read, (_child, _i, wide) => (wide ? inks.wide : inks.shown), () => undefined, true);
  assert.deepEqual(items[0], { box: [0, 6, 8, 18], centre: 11 });
  assert.deepEqual(widest[0], { box: [0, 2, 30, 20], centre: 11 });
  assert.deepEqual(bands, [[-9, 9]]);
});

test('capShare: capitals and digits as a share of the cased characters', () => {
  assert.equal(I.capShare('+3'), 1);
  assert.equal(I.capShare('XP'), 1);
  assert.equal(I.capShare('correct'), 0);
  assert.equal(I.capShare('5 of 5 correct'), 2 / 11);
  assert.equal(I.capShare('+3 pearls'), 1 / 7);
  assert.equal(I.capShare('Level ۱۲'), 3 / 7, 'Extended Arabic-Indic digits count as digits');
});

test('textInk: the union of drawn glyphs, and the band by case', () => {
  const heights = { cap: 14, x: 10 };
  const glyphs = [[0, 6, 8, 20], [9, 5, 9, 20], [10, 4, 18, 24]]; // the middle glyph is a space
  assert.deepEqual(I.textInk(glyphs, 20, 20, 'AG', heights), { box: [0, 4, 18, 24], band: [6, 20] });
  assert.deepEqual(I.textInk(glyphs, 20, 20, '+3', heights).band, [6, 20], 'digits and signs stand on the cap height');
  assert.deepEqual(I.textInk(glyphs, 20, 20, 'ag', heights).band, [10, 20], 'lowercase on the x-height');
  // A mixed label stands between, by the share of capitals and digits: "Ag" half way, "5 of 5 correct" 2/11 of the way up from x-height.
  assert.deepEqual(I.textInk(glyphs, 20, 20, 'Ag', heights).band, [8, 20]);
  assert.deepEqual(I.textInk(glyphs, 20, 20, '5 of 5 correct', heights).band, [20 - (10 + (2 / 11) * 4), 20]);
  // A face with one height stands on it; capitals with no cap height are judged by their ink.
  assert.deepEqual(I.textInk(glyphs, 20, 20, 'Ag', { cap: 14, x: 0 }).band, [6, 20]);
  assert.deepEqual(I.textInk(glyphs, 20, 20, 'Ag', { cap: 0, x: 10 }).band, [10, 20]);
  assert.deepEqual(I.textInk(glyphs, 20, 20, 'AG', { cap: 0, x: 10 }).band, [4, 24]);
  assert.deepEqual(I.textInk(glyphs, 20, 20, 'سکے', heights).band, [4, 24]);
  assert.equal(I.textInk([[3, 3, 3, 3]], 20, 20, ' ', heights), undefined);
});

test('rowLayout: ink edges a fixed gap apart, optical centres on 0, aligned at 0', () => {
  // A coin box 0..18 (centre 9) and a "+3" whose ink is 2..20 across and whose band middle is 13.
  const items = [{ box: [0, 0, 18, 18], centre: 9 }, { box: [2, 6, 20, 20], centre: 13 }];
  const start = I.rowLayout(items, 4, 'start');
  assert.deepEqual(start.moves, [[0, -9], [20, -13]]);
  assert.deepEqual(start.box, [0, -9, 40, 9]);
  const centre = I.rowLayout(items, 4, 'center');
  assert.deepEqual(centre.moves, [[-20, -9], [0, -13]]);
  // Right to left the first item sits on the right.
  const rtl = I.rowLayout(items, 4, 'center', true);
  assert.deepEqual(rtl.moves, [[2, -9], [-22, -13]]);
});

test('plateBox: sized from the widest sample and the tallest band, so it never resizes with the value', () => {
  const coin = { box: [0, 0, 18, 18], centre: 9 };
  const widest = { box: [0, 6, 36, 20], centre: 13 }; // "+888"
  const plate = I.plateBox([coin, widest], [[-9, 9], [-7, 7]], 4, 'center', false, [12, 6]);
  assert.deepEqual(plate, [-41, -15, 41, 15]);
});

test('assetInkBoxes: a row text is judged on the band it is centred by, its widest sample\'s', () => {
  const { T } = loadModules({ T: './runtime/asset-trace.ts' });
  const asset = T.parseAssetSource(JSON.stringify({
    schema: 'skac.asset/1', name: 'Row',
    artboard: { width: 180, height: 120, nodes: [{ kind: 'group', x: 90, y: 60,
      row: { gap: 4, align: 'center', plate: { padding: [10, 6], fill: '#FFF6DC', widest: 'WIDE' } },
      children: [
        { kind: 'ellipse', x: 0, y: 0, width: 18, height: 18, fill: '#E6B43C' },
        { kind: 'text', text: { value: 'count' }, x: 0, y: 0, width: 80, fontSize: 20, fill: '#1D2B2A' },
      ] }] },
    channels: {}, clips: { show: { ms: 0, tracks: {} } },
    machine: { schema: 'skac.machine/1', values: { count: { type: 'string', default: 'short' } },
      layers: [{ name: 'c', entry: 'show', states: { show: { clip: 'show' } } }] },
  }));
  // A caseless short word inks 6..18; the widest sample 2..20. The text sits centred on 11 (the widest band's middle), at y 60.
  const extent = (_node, _where, text) => (text === 'WIDE'
    ? { left: 0, top: 2, width: 30, height: 18, band: [2, 20], source: 'layout' }
    : { left: 0, top: 6, width: 8, height: 12, band: [6, 18], source: 'layout' });
  const entries = T.assetInkBoxes(asset, {}, { count: 'short' }, extent);
  const text = entries.get('artboard.nodes[0].children[1]');
  assert.deepEqual(text.text.band, [51, 69]);
  assert.deepEqual([text.box[1], text.box[3]], [55, 67]);
});
