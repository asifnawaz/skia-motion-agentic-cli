import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { execute } from '../../src/cli.js';
import { tmp, write } from './helpers.js';

const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL('../../runtime/useMotionAsset.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', './asset-load'],
}).outputFiles[0].text;

test('loading binary audio encodes each shared resource once and preserves cue names', () => {
  const { outputFiles: [{ text }] } = buildSync({
    entryPoints: [fileURLToPath(new URL('../../runtime/asset-load.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['./asset-draw', './base64'],
  });
  const encoded = [];
  const modules = {
    './asset-draw': { decodeAssetImages: () => ({}), prepareAssetDrawing: () => ({}) },
    './base64': {
      encodeBase64(bytes) {
        const base64 = Buffer.from(bytes).toString('base64');
        encoded.push(base64);
        return base64;
      },
    },
  };
  const module = { exports: {} };
  new Function('module', 'require', text)(module, (name) => modules[name]);

  const cwd = tmp('binary-audio-');
  const scene = JSON.parse(readFileSync(new URL('../../templates/assets/game-hud.json', import.meta.url), 'utf8'));
  const cue = 'data:audio/wav;base64,UklGRgAAAABXQVZF';
  const other = 'data:audio/aac;base64,UklGRgAAAABXQVZF';
  scene.audio = { first: cue, second: cue, third: other };
  write(join(cwd, 'scene.motion.json'), JSON.stringify(scene));
  const { file } = execute(['asset', 'pack', 'scene.motion.json', '--format=binary'], cwd);
  const { loadMotionAsset } = module.exports;
  assert.deepEqual(loadMotionAsset(readFileSync(file)).audio, scene.audio);
  assert.deepEqual(encoded, ['UklGRgAAAABXQVZF', 'UklGRgAAAABXQVZF']);
  assert.deepEqual(loadMotionAsset(JSON.stringify(scene)).audio, scene.audio);
  assert.equal(encoded.length, 2);
});

test('asset loading shares pending resources, aborts released sources, and ignores late results', async () => {
  let current;
  const prepared = [];
  const modules = {
    react: {
      useMemo: (compute) => compute(),
      useState: () => {
        const consumer = current;
        return [consumer.state, (value) => {
          consumer.state = typeof value === 'function' ? value(consumer.state) : value;
        }];
      },
      useEffect: (effect, [key]) => {
        if (current.key === key) return;
        current.cleanup?.();
        current.key = key;
        current.cleanup = effect();
      },
    },
    './asset-load': {
      async preloadMotionAsset(text, options) {
        const asset = { text, options };
        prepared.push(asset);
        return asset;
      },
    },
  };
  const module = { exports: {} };
  new Function('module', 'require', bundle)(module, (name) => modules[name]);
  const use = (consumer, source, options) => {
    current = consumer;
    return module.exports.useMotionAsset(source, options);
  };
  const pending = [];
  const source = {
    key: 'custom',
    read: (signal) => new Promise((resolve) => pending.push({ resolve, signal })),
  };
  const left = {};
  const right = {};
  assert.equal(use(left, source).status, 'loading');
  assert.equal(use(right, source).status, 'loading');
  await setImmediate();
  assert.equal(pending.length, 1);
  pending[0].resolve('first');
  await setImmediate();
  const loaded = use(left, source).asset;
  assert.equal(loaded, use(right, source).asset);
  assert.equal(prepared.length, 1);

  assert.equal(use(left, source, { artboard: 'wide' }).status, 'loading');
  await setImmediate();
  assert.equal(pending.length, 2);
  use(left, 'next');
  await setImmediate();
  assert.equal(pending[1].signal.aborted, true);
  assert.equal(pending[0].signal.aborted, false);
  pending[1].resolve('stale');
  await setImmediate();
  assert.equal(use(left, 'next').asset.text, 'next');
  assert.deepEqual(prepared.map(({ text }) => text), ['first', 'next']);
  right.cleanup();
  assert.equal(pending[0].signal.aborted, true);
  left.cleanup();

  const firstImage = {};
  const secondImage = {};
  const appA = {};
  const appB = {};
  const appC = {};
  const variant = (portrait, accent) => ({ imageSlots: { portrait }, palette: { accent } });
  const firstVariant = variant(firstImage, '#FFAA00');
  const secondVariant = variant(secondImage, '#FFAA00');
  use(appA, 'photo', firstVariant);
  use(appB, 'photo', secondVariant);
  use(appC, 'photo', variant(firstImage, '#FFAA00'));
  await setImmediate();
  const photoA = use(appA, 'photo', firstVariant).asset;
  const photoB = use(appB, 'photo', secondVariant).asset;
  assert.notEqual(photoA, photoB);
  assert.equal(photoA.options.imageSlots.portrait, firstImage);
  assert.equal(photoB.options.imageSlots.portrait, secondImage);
  assert.equal(photoA, use(appC, 'photo', firstVariant).asset);
  const colorVariant = variant(firstImage, '#00AAFF');
  assert.equal(use(appC, 'photo', colorVariant).status, 'loading');
  await setImmediate();
  assert.notEqual(use(appC, 'photo', colorVariant).asset, photoA);
  for (const consumer of [appA, appB, appC]) consumer.cleanup();

  const firstFace = {};
  const secondFace = {};
  const fontA = {};
  const fontB = {};
  const fontC = {};
  const withFace = (face) => ({ fontSlots: { label: face } });
  use(fontA, 'caption', withFace(firstFace));
  use(fontB, 'caption', withFace(secondFace));
  use(fontC, 'caption', withFace(firstFace));
  await setImmediate();
  const firstFontAsset = use(fontA, 'caption', withFace(firstFace)).asset;
  const secondFontAsset = use(fontB, 'caption', withFace(secondFace)).asset;
  assert.notEqual(firstFontAsset, secondFontAsset);
  assert.equal(firstFontAsset, use(fontC, 'caption', withFace(firstFace)).asset);
  assert.equal(firstFontAsset.options.fontSlots.label, firstFace);
  assert.equal(secondFontAsset.options.fontSlots.label, secondFace);
  // fontB already holds that prepared file, so switching to it is ready at once.
  assert.equal(use(fontC, 'caption', withFace(secondFace)).asset, secondFontAsset);
  await setImmediate();
  assert.equal(use(fontC, 'caption', withFace(secondFace)).asset, secondFontAsset);
  for (const consumer of [fontA, fontB, fontC]) consumer.cleanup();

  const bytes = Uint8Array.of(83, 75, 77, 79);
  const binaryA = {};
  const binaryB = {};
  const binaryC = {};
  use(binaryA, bytes);
  use(binaryB, bytes);
  const separate = bytes.slice();
  use(binaryC, separate);
  await setImmediate();
  const packed = use(binaryA, bytes).asset;
  assert.equal(packed.text, bytes);
  assert.equal(use(binaryB, bytes).asset, packed);
  assert.notEqual(use(binaryC, separate).asset, packed);
  for (const consumer of [binaryA, binaryB, binaryC]) consumer.cleanup();
});

test('preloadMotionAssets keeps files ready for players mounted later, until released', async () => {
  let current;
  const prepared = [];
  const modules = {
    react: {
      useMemo: (compute) => compute(),
      useState: () => {
        const consumer = current;
        return [consumer.state, (value) => {
          consumer.state = typeof value === 'function' ? value(consumer.state) : value;
        }];
      },
      useEffect: (effect, [key]) => {
        if (current.key === key) return;
        current.cleanup?.();
        current.key = key;
        current.cleanup = effect();
      },
    },
    './asset-load': {
      async preloadMotionAsset(text, options) {
        const asset = { text, options };
        prepared.push(asset);
        return asset;
      },
    },
  };
  const module = { exports: {} };
  new Function('module', 'require', bundle)(module, (name) => modules[name]);
  const { preloadMotionAssets, useMotionAsset } = module.exports;
  const use = (consumer, source, options) => {
    current = consumer;
    return useMotionAsset(source, options);
  };
  const reads = [];
  const source = (key) => ({ key, read: (signal) => { reads.push({ key, signal }); return Promise.resolve(key); } });

  const held = preloadMotionAssets([source('reward'), source('shelf')], { artboard: 'wide' });
  const [reward, shelf] = await held.ready;
  assert.deepEqual([reward.text, shelf.text], ['reward', 'shelf']);

  // A player mounted after the preload is ready on its first render, with no second read or prepare.
  const screen = {};
  const first = use(screen, source('reward'), { artboard: 'wide' });
  assert.equal(first.status, 'ready');
  assert.equal(first.asset, reward);
  assert.equal(prepared.length, 2);
  assert.equal(reads.length, 2);
  // Other options are a different prepared file.
  assert.equal(use({}, source('reward')).status, 'loading');

  // The player leaving does not drop a file the preload still holds.
  screen.cleanup();
  assert.equal(use({}, source('shelf'), { artboard: 'wide' }).asset, shelf);
  assert.equal(reads.every(({ signal }) => !signal.aborted), true);

  // Release drops both; a later player loads again. Releasing twice is harmless.
  held.release();
  held.release();
  const later = {};
  assert.equal(use(later, source('reward'), { artboard: 'wide' }).status, 'loading');
  await setImmediate();
  assert.notEqual(use(later, source('reward'), { artboard: 'wide' }).asset, reward);
  later.cleanup();
});
