import test from 'node:test';
import assert from 'node:assert/strict';
import { restSpec } from '../../src/rest.js';

const BG = 'FFF4EEDD';
const BODY = 'FF2E7D5B';
const SPROUT = 'FF8BC34A';

// A fake still: background, then filled rectangles in order (pixel = floor of pt at scale 1).
const fakeStill = (rects, width = 400, height = 600) => ({
  width,
  height,
  at: (x, y) => {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    let c = BG;
    for (const r of rects) if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) c = r.color;
    return c;
  },
});

const depsFor = (still) => {
  const calls = [];
  return {
    calls,
    pixels: { stillPixels: (cfg, name, opts) => { calls.push(opts); return still; } },
    rig: { loadRig: () => ({ meta: { scale: 1 } }) },
  };
};

const body = { x: 118, y: 388, w: 154, h: 174 };
const drawn = fakeStill([{ ...body, color: BODY }]);

test('a box on its drawing passes, from one still at frame 0', () => {
  const deps = depsFor(drawn);
  const r = restSpec({}, 'Character', { parts: { body } }, deps);
  assert.deepEqual(r, { findings: [], skipped: [] });
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].frame, 0);
});

test('parts given as an array pass the same way', () => {
  const r = restSpec({}, 'Character', { parts: [{ name: 'body', ...body }] }, depsFor(drawn));
  assert.equal(r.findings.length, 0);
});

test('a box shifted 6 pt fails with its part', () => {
  const r = restSpec({}, 'Character', { parts: { body: { ...body, x: body.x + 6 } } }, depsFor(drawn));
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.ruleId, 'skac/rest-spec');
  assert.equal(f.severity, 'error');
  assert.equal(f.part, 'body');
  assert.ok(f.edges.includes('right'), `right edge should fail: ${f.edges}`);
  assert.ok(!f.edges.includes('top'));
});

test('a box shifted 6 pt down fails on top and bottom', () => {
  const r = restSpec({}, 'Character', { parts: { body: { ...body, y: body.y + 6 } } }, depsFor(drawn));
  assert.deepEqual(r.findings[0].edges, ['top', 'bottom']);
});

test('tol is clamped below half the short side, so a thin box still passes', () => {
  const stem = { x: 190, y: 360, w: 40, h: 2 };
  const still = fakeStill([{ ...body, color: BODY }, { ...stem, color: SPROUT }]);
  const r = restSpec({}, 'Character', { parts: { body, stem } }, depsFor(still));
  assert.deepEqual(r.findings, []);
});

test('a failed still goes in skipped, with no findings', () => {
  const deps = { pixels: { stillPixels: () => { throw new Error('rendering frame 0 of Character failed'); } } };
  const r = restSpec({}, 'Character', { parts: { body } }, deps);
  assert.equal(r.findings.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].ruleId, 'skac/rest-spec');
  assert.match(r.skipped[0].reason, /failed/);
});

test('no parts never touches deps.pixels', () => {
  assert.deepEqual(restSpec({}, 'Character', {}, {}), { findings: [], skipped: [] });
});

test('a fill within 24 per channel of the background is not seen; 25 away is', () => {
  const near = fakeStill([{ ...body, color: 'FFF4EEF5' }]);
  assert.equal(restSpec({}, 'C', { parts: { body } }, depsFor(near)).findings.length, 1);
  const far = fakeStill([{ ...body, color: 'FFF4EEF6' }]);
  assert.equal(restSpec({}, 'C', { parts: { body } }, depsFor(far)).findings.length, 0);
});

test('a stroked body: the matching box passes, a 6 pt shift fails', () => {
  const stroke = 'FF1B3A2C';
  const inner = { x: body.x + 4, y: body.y + 4, w: body.w - 8, h: body.h - 8 };
  const still = fakeStill([{ ...body, color: stroke }, { ...inner, color: BODY }]);
  assert.equal(restSpec({}, 'C', { parts: { body } }, depsFor(still)).findings.length, 0);
  const shifted = restSpec({}, 'C', { parts: { body: { ...body, x: body.x + 6 } } }, depsFor(still));
  assert.equal(shifted.findings[0].part, 'body');
  // Known limit (rest.js header): a box inset onto the stroke-to-fill line passes.
  assert.equal(restSpec({}, 'C', { parts: { body: inner } }, depsFor(still)).findings.length, 0);
});
