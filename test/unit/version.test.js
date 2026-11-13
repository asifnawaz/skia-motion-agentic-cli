import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execute } from '../../src/cli.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('--version answers with the package version', () => {
  assert.deepEqual(execute(['--version']), { ok: true, name: 'skac', version: pkg.version });
});
