import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULES } from '../../src/rules.js';
import { DOC, FIXED, ROOT, render } from '../../scripts/rules-doc.js';

test('rules-doc: docs/rules.md is what `npm run docs:rules` writes', () => {
  const current = readFileSync(DOC, 'utf8');
  assert.equal(render(current), current, 'docs/rules.md is stale: run `npm run docs:rules`');
});

test('rules-doc: every hard-coded check id is still in its source file', () => {
  for (const r of FIXED) assert.ok(readFileSync(join(ROOT, r.file), 'utf8').includes(`'${r.id}'`), `${r.id} not in ${r.file}`);
});

test('rules-doc: every rule and fixed check has a row in docs/motion/checks.md', () => {
  const doc = readFileSync(join(ROOT, 'docs/motion/checks.md'), 'utf8');
  for (const id of [...Object.keys(RULES), ...FIXED.map((r) => r.id)]) assert.ok(doc.includes(`| \`${id}\``), `${id} has no row in docs/motion/checks.md`);
});
