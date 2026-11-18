import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { assertSettled, DRAFT_FILE, gatedCheck } from '../../src/draft.js';
import { tmp, write } from './helpers.js';

test('machine draft gate follows transitive helpers from clips and draw', () => {
  const dir = tmp();
  const rig = join(dir, 'src', 'Invite.rig.ts');
  const helper = join(dir, 'src', 'helpers', 'curve.ts');
  const paint = join(dir, 'src', 'helpers', 'paint.ts');
  write(join(dir, 'skia-motion.json'), '{}');
  write(rig, 'export const rig = () => ({});');
  write(join(dir, 'src', 'Invite.machine.json'), '{}');
  write(join(dir, 'src', 'Invite.clips.ts'), "import { curve } from './helpers';");
  write(join(dir, 'src', 'Invite.draw.ts'), "import { paint } from './helpers/paint';");
  write(join(dir, 'src', 'helpers', 'index.ts'), "export { curve } from './curve';");
  write(helper, 'export const curve = 1;');
  write(paint, 'export const paint = 1;');

  const cfg = loadConfig(dir);
  const deps = { rig: { loadRig: () => ({ file: rig }) } };
  const check = () => gatedCheck(cfg, 'Invite', {}, deps, () => ({ ok: true, failures: [], warnings: [] }));
  const settled = () => assertSettled(cfg, 'Invite', deps);
  const hash = () => JSON.parse(readFileSync(join(dir, DRAFT_FILE), 'utf8')).Invite.hash;
  assert.equal(check().draft, true);
  const draftHash = hash();
  assert.equal(check().draft, true);
  assert.equal(hash(), draftHash);

  write(helper, 'export const curve = 2;');
  assert.equal(check().ok, true);
  assert.notEqual(hash(), draftHash);
  assert.doesNotThrow(settled);

  write(paint, 'export const paint = 2;');
  assert.throws(settled, /Invite changed since its last --check/);
  assert.equal(check().ok, true);
  assert.doesNotThrow(settled);
});
