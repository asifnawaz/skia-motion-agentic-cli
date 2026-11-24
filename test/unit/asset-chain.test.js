import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../../src/cli.js';
import { tmp } from './helpers.js';

// A chest opens: it shakes, the shake's last swing knocks the lid open, the lid's opening sends three coins out, and the first coin's
// peak sets off a sparkle. The options move a beat's first key so a test can break the chain.
function chest({ lid = 600, coins = 820, sparkle = 1020, chain, register = 'earned' } = {}) {
  const at = (start, from, to, length = 200) => [[0, from], [start, from], [start + length, to, 'out']];
  return {
    schema: 'skac.asset/1', name: 'ChestOpen',
    artboard: { width: 200, height: 200, nodes: [
      { kind: 'group', x: 100, y: 140, rotation: 'tilt', children: [{ kind: 'roundRect', x: -40, y: -30, width: 80, height: 60, radius: 8, fill: '#8A5A2B' }] },
      { kind: 'group', x: 100, y: 'lidY', children: [{ kind: 'roundRect', x: -42, y: -10, width: 84, height: 20, radius: 6, fill: '#A0682F' }] },
      ...[0, 1, 2].map((i) => ({ kind: 'group', x: `coin${i}X`, y: 90, children: [{ kind: 'ellipse', x: -6, y: -6, width: 12, height: 12, fill: '#E6B43C' }] })),
      { kind: 'group', x: 140, y: 50, scaleX: 'sparkle', scaleY: 'sparkle', children: [{ kind: 'ellipse', x: -4, y: -4, width: 8, height: 8, fill: '#FFF2B0' }] },
    ] },
    channels: { tilt: 0, lidY: 110, coin0X: 100, coin1X: 100, coin2X: 100, sparkle: 0 },
    clips: { idle: { ms: 0, tracks: {} }, open: { ms: 1400, tracks: {
      tilt: [[0, 0], [100, 0], [250, -8], [400, 6], [580, 0]],
      lidY: at(lid, 110, 70),
      coin0X: at(coins, 100, 40, 300), coin1X: at(coins + 40, 100, 110, 300), coin2X: at(coins + 80, 100, 160, 300),
      sparkle: [[0, 0], [sparkle, 0], [sparkle + 120, 1.2, 'out'], [sparkle + 300, 0]],
    } } },
    machine: { schema: 'skac.machine/1', values: { open: { type: 'trigger' } }, layers: [{ name: 'chest', entry: 'idle',
      states: { idle: { clip: 'idle' }, open: { clip: 'open', loop: 'once' } }, transitions: [{ from: 'idle', to: 'open', when: [['open']] }] }] },
    register,
    ...(chain !== null && { chain: chain ?? { clip: 'open', beats: [
      { id: 'shake', channels: ['tilt'], contacts: { knock: 'end' } },
      { id: 'lid', channels: ['lidY'], cause: 'shake@knock', contacts: { open: 'end' } },
      { id: 'coins', channels: ['coin0X', 'coin1X', 'coin2X'], cause: 'lid@open', contacts: { peak: 1000 } },
      { id: 'sparkle', channels: ['sparkle'], cause: 'coins@peak' },
    ] } }),
  };
}

const check = async (asset) => {
  const cwd = tmp('asset-chain-');
  const file = join(cwd, 'chest.motion.json');
  writeFileSync(file, JSON.stringify(asset));
  try {
    return await execute(['asset', 'check', file], cwd);
  } catch (error) {
    return { ok: false, error: error.message, ...error.extra };
  }
};

test('causal-chain: each beat starting at the contact that causes it passes, and the report gives the times', async () => {
  const result = await check(chest());
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.chain.beats.map(({ id, cause, start_ms }) => [id, cause, start_ms]),
    [['shake', null, 100], ['lid', 'shake@knock', 600], ['coins', 'lid@open', 820], ['sparkle', 'coins@peak', 1020]]);
  assert.deepEqual(result.chain.unclaimed, []);
});

test('causal-chain: a beat on a timer, not at its contact, fails with its gap', async () => {
  const late = await check(chest({ lid: 700 }));
  assert.match(late.error, /^beat lid starts 120 ms after its cause shake@knock \(580 ms\); it must start 0 to 80 ms after/);
  const early = await check(chest({ coins: 700 }));
  assert.match(early.error, /^beat coins starts 100 ms before its cause lid@open \(800 ms\)/);
});

test('causal-chain: only the trigger beat may start on its own, and two beats off one contact at one ms are layering', async () => {
  const chain = chest().chain;
  const uncaused = await check(chest({ chain: { ...chain, beats: chain.beats.map((beat) => (beat.id === 'lid' ? { ...beat, cause: undefined } : beat)) } }));
  assert.match(uncaused.error, /2 beats have no cause \(shake, lid\); only the first beat, the trigger, may start on its own/);
  const layered = await check(chest({ sparkle: 820, chain: { ...chain, beats: [...chain.beats.slice(0, 3), { id: 'sparkle', channels: ['sparkle'], cause: 'lid@open' }] } }));
  assert.equal(layered.ok, true, layered.error);
  assert.ok(layered.warnings.some(({ code, error }) => code === 'causal-chain-layered' && error === 'coins, sparkle all start at 820 ms off lid@open: that is layering, not chaining'));
});

test('causal-chain: an earned moment with no chain fails and lists its channels by when they start', async () => {
  const result = await check(chest({ chain: null }));
  assert.match(result.error, /^an earned moment declares no chain/);
  assert.deepEqual(result.chain.unclaimed.map(({ start_ms }) => start_ms), [100, 600, 820, 860, 900, 1020]);
  assert.equal((await check(chest({ chain: null, register: 'chrome' }))).ok, true);
});

test('causal-chain: register and chain are authoring-only; pack drops them', async () => {
  const cwd = tmp('asset-chain-pack-');
  const file = join(cwd, 'chest.motion.json');
  writeFileSync(file, JSON.stringify(chest()));
  const packed = readFileSync((await execute(['asset', 'pack', file], cwd)).file, 'utf8');
  assert.ok(!packed.includes('"register"') && !packed.includes('"chain"'));
});
