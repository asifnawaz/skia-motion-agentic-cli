import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../../src/cli.js';
import { assetRuntime } from '../../src/asset-runtime.js';
import { migrateFile } from '../../src/asset-migrate.js';
import { tmp, write } from './helpers.js';

const sample = (name) => JSON.parse(readFileSync(new URL(`../../templates/assets/${name}.json`, import.meta.url), 'utf8'));
const run = (args, cwd = process.cwd()) => {
  try { return execute(args, cwd); } catch (error) { return { ok: false, error: error.message }; }
};

test('every file so far is format 1.0: migrate finds nothing to do and writes nothing', () => {
  const cwd = tmp('migrate-current-');
  write(join(cwd, 'hud.motion.json'), JSON.stringify(sample('game-hud')));
  const packed = run(['asset', 'pack', 'hud.motion.json', '--format=binary', '--out=hud.skmotion'], cwd);
  assert.equal(packed.ok, true);
  for (const file of ['hud.motion.json', 'hud.skmotion']) {
    const result = run(['asset', 'migrate', file], cwd);
    assert.equal(result.ok, true);
    assert.equal(result.current, true);
    assert.equal(result.from, '1.0');
    assert.deepEqual(result.steps, []);
  }
  assert.equal(run(['asset', 'migrate', 'hud.motion.json', '--to=1.1'], cwd).ok, false);
});

test('a registered step upgrades a file and names what it changed', () => {
  const step = {
    from: { major: 1, minor: 0 }, to: { major: 1, minor: 1 }, title: 'rename a channel',
    migrate(file) {
      const { healthWidth, ...rest } = file.channels;
      return { ...file, minor: 1, channels: { ...rest, barWidth: healthWidth } };
    },
  };
  const file = sample('game-hud');
  const result = migrateFile(file, { target: { major: 1, minor: 1 }, registry: [step] });
  assert.deepEqual(result.steps, [{ from: '1.0', to: '1.1', title: 'rename a channel' }]);
  assert.equal(result.file.minor, 1);
  assert.ok(result.changes.includes('minor'));
  assert.ok(result.changes.includes('channels.barWidth') && result.changes.includes('channels.healthWidth'));
  assert.equal(file.minor, undefined, 'the input is not changed');
  assert.throws(() => migrateFile(file, { target: { major: 1, minor: 2 }, registry: [step] }), /no migration from format 1.1/);
  assert.throws(() => migrateFile({ ...file, minor: 3 }, { target: { major: 1, minor: 1 }, registry: [step] }), /newer than 1.1/);
});

test('the runtime reads a newer minor by skipping what it does not know, and stays strict otherwise', () => {
  const { parseAssetFile } = assetRuntime();
  const file = sample('game-hud');
  const newer = {
    ...file, minor: 1, glow: { strength: 2 },
    artboard: { ...file.artboard, nodes: [...file.artboard.nodes, { kind: 'sparkle', count: 3 }], futureField: true },
  };
  newer.artboard.nodes[0] = { ...newer.artboard.nodes[0], shimmer: 0.5 };
  const parsed = parseAssetFile(JSON.stringify(newer));
  assert.equal(parsed.artboard.nodes.length, file.artboard.nodes.length, 'the unknown node kind is dropped');
  const { minor: _minor, ...baseline } = newer;
  assert.throws(() => parseAssetFile(JSON.stringify(baseline)), /unknown field/);
  assert.throws(() => parseAssetFile(JSON.stringify({ ...file, minor: 0 })), /expected an integer from 1/);
});

test('a different major is refused with the way forward', () => {
  const { parseAssetFile } = assetRuntime();
  const file = sample('game-hud');
  assert.throws(() => parseAssetFile(JSON.stringify({ ...file, schema: 'skac.asset/2' })), /update skia-motion-runtime to a release that reads format 2/);
  assert.throws(() => parseAssetFile(JSON.stringify({ ...file, schema: 'skac.asset/0' })), /run skac asset migrate/);
  assert.throws(() => parseAssetFile(JSON.stringify({ ...file, schema: 'other' })), /this player reads skac.asset\/1/);
});

test('the CLI checks and packs only formats it fully reads', () => {
  const cwd = tmp('migrate-newer-');
  write(join(cwd, 'newer.motion.json'), JSON.stringify({ ...sample('game-hud'), minor: 1 }));
  const checked = run(['asset', 'check', 'newer.motion.json'], cwd);
  assert.equal(checked.ok, false);
  assert.match(checked.error, /newer than this skac reads/);
});

test('review fixes: binary and bundle files of a newer minor are refused by the CLI, the way forward comes first', () => {
  const { parseAssetFile } = assetRuntime();
  const file = sample('game-hud');
  // Another major with a field this runtime does not know still gets the way forward.
  assert.throws(() => parseAssetFile(JSON.stringify({ ...file, schema: 'skac.asset/2', effects: {} })), /update skia-motion-runtime/);
  // A newer minor may add machine keys too.
  const machine = { ...file.machine, futureKey: true };
  assert.doesNotThrow(() => parseAssetFile(JSON.stringify({ ...file, minor: 1, machine })));
  assert.throws(() => parseAssetFile(JSON.stringify({ ...file, machine })), /unknown key "futureKey"/);
  // Malformed nodes are still reported, and an artboard of only new kinds is refused, not drawn empty.
  assert.throws(() => parseAssetFile(JSON.stringify({ ...file, minor: 1, artboard: { ...file.artboard, nodes: [...file.artboard.nodes, null] } })), /expected an object/);
  assert.throws(() => parseAssetFile(JSON.stringify({ ...file, minor: 1, artboard: { ...file.artboard, nodes: [{ kind: 'sparkle' }] } })), /add at least one shape/);

  const cwd = tmp('migrate-newer-binary-');
  write(join(cwd, 'newer.motion.json'), JSON.stringify({ ...file, minor: 1 }));
  const { encodeBinaryAsset } = assetRuntime();
  const { data } = encodeBinaryAsset({ ...file, minor: 1 }, (text) => Buffer.from(text, 'utf8'), 1 << 20);
  write(join(cwd, 'newer.skmotion'), Buffer.from(data));
  write(join(cwd, 'bundle.motion.json'), JSON.stringify({ schema: 'skac.bundle/1', minor: 1, name: 'pair', defaultArtboard: 'hud', artboards: { hud: file } }));
  for (const name of ['newer.skmotion', 'bundle.motion.json']) {
    const checked = run(['asset', 'check', name], cwd);
    assert.equal(checked.ok, false, name);
    assert.match(checked.error, /newer than this skac reads/, name);
  }
});
