import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseArgs, parseCommands, parseEvents } from '../../src/args.js';
import { tmp, write } from './helpers.js';

test('parseEvents reads name@seconds tokens', () => {
  assert.deepEqual(parseEvents('tap@4.0 correct@6.5'), [{ name: 'tap', at: 4 }, { name: 'correct', at: 6.5 }]);
  assert.deepEqual(parseEvents('a@1,b@.5'), [{ name: 'a', at: 1 }, { name: 'b', at: 0.5 }]);
  assert.throws(() => parseEvents('tap'), /bad event/);
});

test('parseCommands: inline shorthand and a commands file', () => {
  assert.deepEqual(parseCommands('tap@4.0'), { events: [{ name: 'tap', at: 4 }], captures: [] });
  const f = join(tmp(), 'run.txt');
  write(f, '# a comment\nevent tap 1.0\nadvance 0.5\nscreenshot\nadvance 2\nscreenshot\n');
  assert.deepEqual(parseCommands(f), { events: [{ name: 'tap', at: 1 }], captures: [0.5, 2.5] });
  write(f, 'jump 3\n');
  assert.throws(() => parseCommands(f), /unknown command/);
});

test('parseArgs: both flag spellings, lists, and unknown flags', () => {
  const r = parseArgs(['X', '--at=1,2', '--scale', '3', '--render', '--docs-dir', 'a', '--docs-dir=b'],
    { bool: ['render'], str: ['at', 'scale'], list: ['docs-dir'] });
  assert.deepEqual(r.pos, ['X']);
  assert.deepEqual(r.flags, { at: '1,2', scale: '3', render: true, 'docs-dir': ['a', 'b'] });
  assert.throws(() => parseArgs(['--nope'], {}), /unknown flag/);
});
