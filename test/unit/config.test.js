import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { findConfig, loadConfig } from '../../src/config.js';
import { tmp, write } from './helpers.js';

test('findConfig walks up to the nearest skia-motion.json', () => {
  const root = tmp();
  write(join(root, 'skia-motion.json'), '{"out":"o"}');
  write(join(root, 'a', 'b', 'x.txt'), '');
  assert.equal(findConfig(join(root, 'a', 'b')), join(root, 'skia-motion.json'));
});

test('loadConfig: defaults without a file, file paths relative to the file, flags beat the file', () => {
  const bare = tmp();
  const d = loadConfig(bare);
  assert.equal(d.configPath, null);
  assert.equal(d.entry, join(bare, 'src/index.ts'));
  assert.equal(d.out, join(bare, 'skia-motion-out'));

  const root = tmp();
  write(join(root, 'skia-motion.json'), JSON.stringify({ out: 'build', root: 'app/Root.tsx', docs: ['notes'] }));
  const sub = join(root, 'sub');
  write(join(sub, 'f'), '');
  const c = loadConfig(sub);
  assert.equal(c.projectDir, root);
  assert.equal(c.out, join(root, 'build'));
  assert.equal(c.root, join(root, 'app/Root.tsx'));
  assert.deepEqual(c.docs, [join(root, 'notes')]);
  assert.equal(loadConfig(sub, { out: 'x' }).out, join(sub, 'x'));
});

test('loadConfig returns the file\'s rules, {} without a file, and refuses rules that are not an object', () => {
  assert.deepEqual(loadConfig(tmp()).rules, {});
  const root = tmp();
  const rules = { 'skac/speed-cap': 'error', 'skac/no-magic-motion': 'warn' };
  write(join(root, 'skia-motion.json'), JSON.stringify({ rules }));
  assert.deepEqual(loadConfig(root).rules, rules);
  const bad = tmp();
  write(join(bad, 'skia-motion.json'), JSON.stringify({ rules: ['skac/speed-cap'] }));
  assert.throws(() => loadConfig(bad), /"rules" .* is not an object/);
});

test('loadConfig rejects a config that is not JSON', () => {
  const root = tmp();
  write(join(root, 'skia-motion.json'), '{nope');
  assert.throws(() => loadConfig(root), /not valid JSON/);
});

test('loadConfig: gl comes from --gl, then SKAC_GL, then the file, then angle-egl; unknown values fail', () => {
  const root = tmp();
  const saved = process.env.SKAC_GL;
  delete process.env.SKAC_GL;
  try {
    assert.equal(loadConfig(root).gl, 'angle-egl');
    write(join(root, 'skia-motion.json'), JSON.stringify({ gl: 'egl' }));
    assert.equal(loadConfig(root).gl, 'egl');
    process.env.SKAC_GL = 'swangle';
    assert.equal(loadConfig(root).gl, 'swangle');
    assert.equal(loadConfig(root, { gl: 'vulkan' }).gl, 'vulkan');
    assert.throws(() => loadConfig(root, { gl: 'metal' }), /unknown GL backend/);
  } finally {
    if (saved === undefined) delete process.env.SKAC_GL; else process.env.SKAC_GL = saved;
  }
});
