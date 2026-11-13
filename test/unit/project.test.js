import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { inspect, registrations } from '../../src/project.js';
import { tmp, write } from './helpers.js';

test('registrations and inspect read the root file, including multi-line tags and expressions', () => {
  const dir = tmp();
  write(join(dir, 'src', 'Root.tsx'), `import { Composition } from 'remotion';
import { A } from './A';
export const Root = () => <>
  <Composition id="A" component={A} width={390} height={867} fps={30} durationInFrames={240} />
  <Composition
    id="B" component={A} width={100} height={200} fps={24}
    durationInFrames={Math.round(2 * 24) + 1} />
</>;
`);
  write(join(dir, 'src', 'A.tsx'), `const x = 1;\nexport const A = ({ events }) => events.find((e) => e.name === 'tap');\n`);
  const cfg = loadConfig(dir);
  const regs = registrations(cfg);
  assert.equal(regs.length, 2);
  assert.equal(regs[1].frames, null);
  assert.equal(regs[1].frames_expr, 'Math.round(2 * 24) + 1');
  const i = inspect(cfg, 'A');
  assert.deepEqual([i.width, i.height, i.fps, i.frames, i.reads_events], [390, 867, 30, 240, true]);
  assert.deepEqual(i.events_handled, ['tap']);
  assert.deepEqual(i.consts, ['x', 'A']);
  assert.throws(() => inspect(cfg, 'Z'), /no composition/);
});
