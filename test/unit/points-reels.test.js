import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadModules } from './helpers.js';

// Golden test: templates/motion/points.ts against what it was ported from, Word Quran's reels kit (reels/_kit/morph.js and
// pixelmotion.js, ported by their owner, NOTICE.md). Same inputs, same points, at k = 1 (far = 1000, the reels' 1080 x 1920
// pixel scale). Skipped where the reels repository is not on disk; SKAC_REELS_KIT names its _kit folder.
const KIT = resolve(process.env.SKAC_REELS_KIT ?? '/media/whoami/linux-data/git/word-quran-reels/reels/_kit');
const have = existsSync(join(KIT, 'morph.js')) && existsSync(join(KIT, 'pixelmotion.js'));

const { P } = loadModules({ P: './templates/motion/points.ts' });
const { R, X } = have ? loadModules({ R: join(KIT, 'morph.js'), X: join(KIT, 'pixelmotion.js') }, {
  '/reels/_kit/kit.js': { W: 1080, H: 1920, font: () => '', seg: (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a))) },
}) : {};
const opts = { skip: have ? false : `no reels kit at ${KIT}` };

// Two point sets 1000 px across, so the default scale k = 1 matches the reels' pixel distances.
const A = P.sortPoints(Array.from({ length: 40 }, (_, i) => [100 + 23 * i, 600 + 40 * Math.sin(i)]), 'x');
const B = P.sortPoints(Array.from({ length: 33 }, (_, i) => [200 + 19 * i, 900 + 60 * Math.cos(i * 0.7)]), 'x');
const PS = [0, 0.13, 0.31, 0.5, 0.64, 0.82, 1];

/** The reels' morph drawn into a recorder: the centre of each square it fills. */
const reelsMorph = (path, stagger, f, seed) => {
  const out = [];
  const g = { save() {}, restore() {}, fillRect: (x, y, w) => out.push({ x: x + w / 2, y: y + w / 2, size: w / 5 }), set fillStyle(_) {} };
  R.morph(g, A, B, f, { path, stagger, seed, trail: false });
  return out;
};

const close = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ours ${a}, reels ${b}`);

test('morphPoints matches reels morph.js for the paths ported as they are', opts, () => {
  for (const path of ['line', 'arc', 'wave', 'burst', 'lift']) {
    for (const stagger of ['x', 'rand', 'dist']) {
      for (const p of PS) {
        const ours = P.morphPoints(A, B, p, { path, stagger, seed: 3, far: 1000 });
        const theirs = reelsMorph(path, stagger, p, 3);
        assert.equal(ours.length, theirs.length);
        ours.forEach((o, i) => {
          close(o.x, theirs[i].x, `${path}/${stagger} p ${p} point ${i} x`);
          close(o.y, theirs[i].y, `${path}/${stagger} p ${p} point ${i} y`);
          close(o.size, theirs[i].size, `${path}/${stagger} p ${p} point ${i} size`);
        });
      }
    }
  }
});

test('morphPoints spiral and orbit land on B as the reels do; they start on A where the reels start turned', opts, () => {
  for (const path of ['spiral', 'orbit']) {
    for (const p of [1]) {
      const ours = P.morphPoints(A, B, p, { path, stagger: 'x', seed: 1, far: 1000 });
      const theirs = reelsMorph(path, 'x', p, 1);
      // The reels' spiral and orbit are turned at e = 0, so a point jumps off A as it leaves; ours turn by sin(pi e), 0 at both ends.
      ours.forEach((o, i) => { close(o.x, theirs[i].x, `${path} p ${p} x`); close(o.y, theirs[i].y, `${path} p ${p} y`); });
    }
  }
});

/** One context both sides read: pointContext's, with k = 1 (far 1000). */
const CTX = P.pointContext(P.sortPoints(Array.from({ length: 36 }, (_, i) => [300 + 60 * (i % 6), 500 + 50 * Math.floor(i / 6)]), 'y'), 1000);

test('arrive matches reels pixelmotion.js pixelAt for the styles ported as they are', opts, () => {
  // Not here, on purpose: vortex (its ring lands round), drop and burst (owner caps: one rebound, 5 % overshoot), glitch (not ported).
  for (const style of ['converge', 'rain', 'rise', 'rows', 'spiral', 'scan', 'dissolve', 'wave', 'zoom', 'arc']) {
    for (const p of PS) {
      CTX.forEach((c, i) => {
        const ours = P.arrive(style, c, p);
        const theirs = X.pixelAt(style, 'reverse', c, p, 0);
        if (theirs === null) { assert.equal(ours, null, `${style} p ${p} point ${i} not yet on screen`); return; }
        close(ours.x, theirs.x, `${style} p ${p} point ${i} x`);
        close(ours.y, theirs.y, `${style} p ${p} point ${i} y`);
        close(ours.size, theirs.size, `${style} p ${p} point ${i} size`);
        close(ours.alpha, theirs.alpha, `${style} p ${p} point ${i} alpha`);
      });
    }
  }
});

test('leave matches reels pixelmotion.js pixelAt for every way out', opts, () => {
  for (const style of ['shatter', 'vapor', 'melt', 'implode', 'reverse']) {
    for (const q of [0.05, 0.3, 0.6, 0.9, 1]) {
      CTX.forEach((c, i) => {
        const ours = P.leave(style, c, q, 'converge');
        const theirs = X.pixelAt('converge', style, c, 1, q);
        close(ours.x, theirs.x, `${style} q ${q} point ${i} x`);
        close(ours.y, theirs.y, `${style} q ${q} point ${i} y`);
        // reverse: the reels drop the arrival's (1 - r2) size factor on the way out, so a point's size jumps as it turns
        // back; ours keeps the arrival's size, continuous. Every other way out is the same.
        if (style !== 'reverse') close(ours.size, theirs.size, `${style} q ${q} point ${i} size`);
        close(ours.alpha, theirs.alpha, `${style} q ${q} point ${i} alpha`);
      });
    }
  }
});
