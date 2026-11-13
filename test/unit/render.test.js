import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { render } from '../../src/render.js';
import { tmp, write } from './helpers.js';

test('--render --out also leaves the render at the default path --check reads', () => {
  const dir = tmp();
  write(join(dir, 'skia-motion.json'), JSON.stringify({ entry: 'src/index.ts', root: 'src/Root.tsx', out: 'out' }));
  write(join(dir, 'src', 'Root.tsx'), '<Composition id="A" component={A} width={390} height={867} fps={30} durationInFrames={4} />\n');
  write(join(dir, 'src', 'A.tsx'), 'export const A = () => null;\n');
  // A fake `npx remotion render <entry> <name> <file> ...` that writes the file; no video is rendered.
  const bin = tmp();
  const npx = join(bin, 'npx');
  writeFileSync(npx, '#!/bin/sh\necho video > "$5"\n');
  chmodSync(npx, 0o755);
  const cfg = loadConfig(dir);
  const was = process.env.PATH;
  process.env.PATH = `${bin}:${was}`;
  const target = join(dir, 'elsewhere', 'mine.mp4');
  try { render(cfg, 'A', { out: target }); } catch { /* the fake file is not a video: compare may fail after the copy */ } finally { process.env.PATH = was; }
  assert.equal(existsSync(target), true);
  assert.equal(existsSync(join(cfg.out, 'A', 'A.mp4')), true);
});
