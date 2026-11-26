import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { measureAssetFrames } from '../../src/asset-canvaskit.js';
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

test('asset cost: mesh vertices are built only when their position channels change', async () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const meshCost = async (x, y, moving) => {
    const vertices = [[0, 0, 0, 0], [x, 0, 1, 0], [0, y, 0, 1]];
    let pointReads = 0;
    // Observe reads of the positions and texture coordinates produced from this mesh only.
    vertices.map = (project) => Array.prototype.map.call(vertices, (vertex, i) => {
      const point = project(vertex, i, vertices);
      if (!point || typeof point !== 'object' || !('x' in point)) return point;
      return {
        get x() { pointReads++; return point.x; },
        get y() { pointReads++; return point.y; },
      };
    });
    const node = { kind: 'mesh', image: 'dot', opacity: 'opacity', vertices, indices: [0, 1, 2] };
    const size = { width: 64, height: 64 };
    const asset = { channels: {}, images: { dot: PNG }, artboard: { ...size, nodes: [node] } };
    // The first (warm-up) pose is hidden. Opacity changes on all 30 visible frames.
    // On moving frames exactly one of the two position channels changes at a time.
    const rows = Array.from({ length: 31 }, (_, frame) => ({
      channels: {
        opacity: frame / 30,
        bendX: 24 + (moving ? Math.floor(frame / 2) : 0),
        bendY: 12 + (moving ? Math.ceil(frame / 2) : 0),
      },
      values: {},
    }));
    const cost = await measureAssetFrames(asset, rows, size);
    const builds = Math.round((cost.byKind.MakeVertices ?? 0) * cost.frames);
    // CanvasKit reads x and y once for each position and UV when MakeVertices consumes them.
    // Any runtime comparison or flatten of the computed positions adds reads above that budget.
    const bridgeReads = builds * vertices.length * 4;
    return { builds, extraPointReads: pointReads - bridgeReads };
  };
  assert.deepEqual(await meshCost(24, 12, true), { builds: 1, extraPointReads: 0 }, 'fixed mesh');
  assert.deepEqual(await meshCost('bendX', 'bendY', false), { builds: 1, extraPointReads: 0 }, 'held position channels');
  assert.deepEqual(await meshCost('bendX', 'bendY', true), { builds: 30, extraPointReads: 0 }, 'moving position channels');
});
