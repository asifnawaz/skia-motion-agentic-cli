import test from 'node:test';
import assert from 'node:assert/strict';
import { CliError, errorDoc, fail, toJson } from '../../src/util.js';

test('errors become {ok:false,error,hint} and one JSON document', () => {
  try { fail('boom', 'try this', { did_you_mean: ['x'] }); } catch (e) {
    assert.ok(e instanceof CliError);
    assert.deepEqual(errorDoc(e), { ok: false, error: 'boom', hint: 'try this', did_you_mean: ['x'] });
  }
  assert.deepEqual(errorDoc(new CliError('no hint')), { ok: false, error: 'no hint' });
  assert.deepEqual(JSON.parse(toJson({ ok: true })), { ok: true });
});
