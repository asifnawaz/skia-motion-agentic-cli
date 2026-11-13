import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { update, writeManifest } from '../../src/update.js';
import { PACKAGE_ROOT } from '../../src/docs.js';
import { write } from './helpers.js';

const TMP = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp');
mkdirSync(TMP, { recursive: true });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const tplMotion = readFileSync(join(PACKAGE_ROOT, 'templates', 'motion', 'motion.ts'), 'utf8');
const offline = () => ({ code: 1, stdout: '', stderr: 'offline', error: new Error('ENOTFOUND') });
const at = (v) => () => ({ code: 0, stdout: v + '\n', stderr: '' });
const state = (doc, path) => doc.files.find((f) => f.path === path)?.state;

/** A project with every managed file freshly written and recorded, like `create` leaves it. */
const project = () => {
  const dir = mkdtempSync(join(TMP, 'upd-'));
  write(join(dir, 'skia-motion.json'), '{}');
  const first = update(loadConfig(dir), { runner: offline });
  assert.ok(first.files.every((f) => f.state === 'added'));
  return dir;
};
const cfg = (dir) => loadConfig(dir);
test.after(() => rmSync(TMP, { recursive: true, force: true }));

test('same: an untouched project reports every file same and writes nothing new', () => {
  const dir = project();
  const doc = update(cfg(dir), { runner: offline });
  assert.ok(doc.files.length >= 6);
  assert.ok(doc.files.every((f) => f.state === 'same'));
  assert.equal(state(doc, 'src/motion/clock.app.ts'), undefined, 'clock.app.ts is not managed');
  assert.equal(doc.hint, undefined);
});

test('updated: a file still equal to the recorded hash is replaced by the new template', () => {
  const dir = project();
  const old = '// old template\n';
  write(join(dir, 'src/motion/motion.ts'), old);
  write(join(dir, '.skac-files.json'), JSON.stringify({ 'src/motion/motion.ts': sha(old) }));
  const doc = update(cfg(dir), { runner: offline });
  assert.equal(state(doc, 'src/motion/motion.ts'), 'updated');
  assert.equal(readFileSync(join(dir, 'src/motion/motion.ts'), 'utf8'), tplMotion);
  assert.equal(JSON.parse(readFileSync(join(dir, '.skac-files.json'), 'utf8'))['src/motion/motion.ts'], sha(tplMotion));
});

test('kept-edited: an edited file is kept and listed with the --force hint', () => {
  const dir = project();
  const mine = '// my edit\n';
  write(join(dir, 'src/motion/motion.ts'), mine);
  const doc = update(cfg(dir), { runner: at('9.9.9') });
  assert.equal(state(doc, 'src/motion/motion.ts'), 'kept-edited');
  assert.equal(readFileSync(join(dir, 'src/motion/motion.ts'), 'utf8'), mine);
  assert.match(doc.hint, /--force/);
  assert.equal(doc.ok, true);
});

test('added: a missing managed file is written', () => {
  const dir = project();
  rmSync(join(dir, 'AGENTS.md'));
  const doc = update(cfg(dir), { runner: offline });
  assert.equal(state(doc, 'AGENTS.md'), 'added');
  assert.ok(existsSync(join(dir, 'AGENTS.md')));
});

test('--force replaces an edited file', () => {
  const dir = project();
  write(join(dir, 'src/motion/motion.ts'), '// my edit\n');
  const doc = update(cfg(dir), { force: true, runner: offline });
  assert.equal(state(doc, 'src/motion/motion.ts'), 'updated');
  assert.equal(readFileSync(join(dir, 'src/motion/motion.ts'), 'utf8'), tplMotion);
});

test('--check reports the same states and writes nothing', () => {
  const dir = project();
  write(join(dir, 'src/motion/motion.ts'), '// my edit\n');
  rmSync(join(dir, 'CLAUDE.md'));
  const doc = update(cfg(dir), { check: true, force: true, runner: offline });
  assert.equal(doc.check, true);
  assert.equal(state(doc, 'CLAUDE.md'), 'added');
  assert.equal(state(doc, 'src/motion/motion.ts'), 'updated');
  assert.ok(!existsSync(join(dir, 'CLAUDE.md')));
  assert.equal(readFileSync(join(dir, 'src/motion/motion.ts'), 'utf8'), '// my edit\n');
});

test('no manifest: files equal to the template are same, others kept-edited', () => {
  const dir = project();
  rmSync(join(dir, '.skac-files.json'));
  write(join(dir, 'src/motion/motion.ts'), '// unknown origin\n');
  const doc = update(cfg(dir), { runner: offline });
  assert.equal(state(doc, 'src/motion/motion.ts'), 'kept-edited');
  assert.equal(state(doc, 'AGENTS.md'), 'same');
  assert.ok(existsSync(join(dir, '.skac-files.json')), 'update records the manifest');
});

test('offline: a failed or garbled npm lookup leaves latest out and is not an error', () => {
  const dir = project();
  for (const runner of [offline, at('not a version')]) {
    const doc = update(cfg(dir), { runner });
    assert.equal(doc.ok, true);
    assert.equal('latest' in doc, false);
    assert.equal('upgrade' in doc, false);
  }
});

test('latest: a newer version names the upgrade command, an equal one does not', () => {
  const dir = project();
  const doc = update(cfg(dir), { runner: at('99.0.0') });
  assert.equal(doc.latest, '99.0.0');
  assert.equal(doc.upgrade, 'npm i -g skia-motion@latest');
  const same = update(cfg(dir), { runner: at(doc.version) });
  assert.equal(same.upgrade, undefined);
});

test('writeManifest records sha256 of the listed managed files and keeps earlier entries', () => {
  const dir = mkdtempSync(join(TMP, 'wm-'));
  write(join(dir, 'src/motion/motion.ts'), tplMotion);
  write(join(dir, 'src/Other.tsx'), 'x');
  writeManifest(dir, ['src/motion/motion.ts', 'src/Other.tsx']);
  writeManifest(dir, ['nope.txt']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.skac-files.json'), 'utf8')), { 'src/motion/motion.ts': sha(tplMotion) });
});
