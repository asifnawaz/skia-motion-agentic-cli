import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { execute } from '../../src/cli.js';

const sample = (name) => fileURLToPath(new URL(`../../templates/assets/${name}.json`, import.meta.url));

test('asset cost: a still or animated shape reuses its paint and rect, so a frame makes almost no Skia objects', async () => {
  for (const name of ['game-hud', 'versus-hud', 'sprout', 'reward-counter']) {
    const cost = await execute(['asset', 'cost', sample(name), '--trace=0:480:16'], process.cwd());
    assert.equal(cost.ok, true);
    assert.equal(cost.frames, 31);
    // 3.4.2 made 57 (game-hud), 48 (versus-hud), 23 (sprout) and 7 (reward-counter) a frame: a paint, color and rect per shape.
    assert.ok(cost.objectsPerFrame <= 2, `${name} makes ${cost.objectsPerFrame} Skia objects a frame: ${JSON.stringify(cost.byKind)}`);
    assert.ok(cost.frameMs.p50 >= 0 && cost.firstFrameMs >= 0);
  }
});

test('asset cost: an animated path builds a new path only on frames where its coordinates change', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'skac-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const builds = async (withPath, trace) => {
    const file = JSON.parse(readFileSync(sample('sprout'), 'utf8'));
    file.channels.bend = 24;
    if (withPath) file.artboard.nodes.push({ kind: 'path', fill: '#336699', commands: [['M', 0, 0], ['L', 'bend', 0], ['L', 0, 12], ['Z']] });
    if (trace) {
      file.clips.idle.ms = 480;
      file.clips.idle.tracks = { ...file.clips.idle.tracks, bend: [[0, 24], [240, 24], [256, 40]] };
    }
    const path = join(dir, `${withPath}-${trace}.motion.json`);
    writeFileSync(path, JSON.stringify(file));
    const cost = await execute(['asset', 'cost', path, '--trace=0:480:16'], process.cwd());
    assert.equal(cost.ok, true, cost.error);
    // byKind is a per-frame average rounded to three places.
    return Math.round((cost.byKind['PathBuilder.Make'] ?? 0) * cost.frames);
  };
  const base = await builds(false, false);
  // Held: the path is built once for the first frame and reused on the rest.
  assert.ok(await builds(true, false) - base <= 1, 'a held path is reused');
  // It changes on one step (240 to 256 ms): one more build than held, and no more.
  const moving = await builds(true, true);
  assert.ok(moving - base >= 1 && moving - base <= 2, `a path that changes once is rebuilt once, got ${moving - base}`);
});
