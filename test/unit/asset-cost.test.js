import assert from 'node:assert/strict';
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
