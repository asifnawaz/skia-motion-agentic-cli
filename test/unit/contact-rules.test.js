import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleRig } from '../../src/rig.js';
import { RULES } from '../../src/rules.js';

const META = { fps: 30, frames: 60, width: 780, height: 1734, scale: 2 }; // 2 s
const run = (id, rig, over = {}) => {
  const meta = { ...META, ...over };
  return RULES[id].check(sampleRig(rig, meta), meta);
};
const foot = (bottom, x = 100) => ({ x, y: bottom - 14, w: 30, h: 14 });
const GROUND = { ground_y: 554, planted: ['foot'] };

test('ground: a planted foot on the ground passes; one that sinks fails with the part, depth and time', () => {
  assert.deepEqual(run('skac/ground', () => ({ channels: {}, parts: { foot: foot(554) } }), GROUND), []);
  const f = run('skac/ground', (ms) => ({ channels: {}, parts: { foot: foot(ms > 1000 && ms < 1200 ? 557 : 554) } }), GROUND);
  assert.equal(f.length, 1);
  assert.equal(f[0].part, 'foot');
  assert.equal(f[0].value, 3);
  assert.ok(f[0].at_s >= 1 && f[0].at_s < 1.2);
});

test('ground: a lift inside an airborne window passes, the same lift outside it fails, two lifts give two findings', () => {
  const hop = (ms) => ({ channels: {}, parts: { foot: foot((ms > 500 && ms < 700) || (ms > 1300 && ms < 1500) ? 540 : 554) } });
  assert.deepEqual(run('skac/ground', hop, { ...GROUND, airborne: [{ from_ms: 450, to_ms: 750 }, { from_ms: 1250, to_ms: 1550, parts: ['foot'] }] }), []);
  assert.equal(run('skac/ground', hop, GROUND).length, 2);
  // A window naming another part does not excuse this one.
  assert.equal(run('skac/ground', hop, { ...GROUND, airborne: [{ from_ms: 0, to_ms: 2000, parts: ['other'] }] }).length, 2);
});

test('ground: a floor part (a shadow) may lie below the line; an unknown planted name is a finding, not a throw', () => {
  const rig = () => ({ channels: {}, parts: { foot: foot(554), shadow: { x: 90, y: 552, w: 50, h: 8 } } });
  assert.equal(run('skac/ground', rig, GROUND).length, 1);
  assert.deepEqual(run('skac/ground', rig, { ...GROUND, floor: ['shadow'] }), []);
  const f = run('skac/ground', rig, { ...GROUND, planted: ['foot', 'toe'], floor: ['shadow'] });
  assert.deepEqual(f.map((x) => x.part), ['toe']);
});

test('ground: a part with no height is a point, judged by its y', () => {
  assert.deepEqual(run('skac/ground', () => ({ channels: {}, parts: { dot: { x: 10, y: 554 } } }), { ground_y: 554 }), []);
  assert.equal(run('skac/ground', () => ({ channels: {}, parts: { dot: { x: 10, y: 560 } } }), { ground_y: 554 }).length, 1);
});

test('attached: a wing swinging on its hinge passes; one that drifts off fails with the part and the drift', () => {
  const body = { x: 100, y: 300, w: 100, h: 100 };
  const meta = { attached: [{ part: 'wing', to: 'body', within_pt: 10 }] };
  // Swinging about a pivot on the body keeps the centre-to-centre distance within a few pt.
  const swing = (ms) => {
    const a = 0.3 * Math.sin(ms / 150);
    return { channels: {}, parts: { body, wing: { x: 200 + 20 * Math.cos(a) - 20, y: 340 + 20 * Math.sin(a), w: 20, h: 20 } } };
  };
  assert.deepEqual(run('skac/attached', swing, meta), []);
  const drift = (ms) => ({ channels: {}, parts: { body, wing: { x: 200 + Math.max(0, ms - 1000) * 0.1, y: 340, w: 20, h: 20 } } });
  const f = run('skac/attached', drift, meta);
  assert.equal(f.length, 1);
  assert.equal(f[0].part, 'wing');
  assert.equal(f[0].limit, 10);
  assert.ok(f[0].value > 10);
  assert.equal(f[0].category, 'contact');
  const g = run('skac/attached', drift, { attached: [{ part: 'wing', to: 'torso', within_pt: 10 }] });
  assert.deepEqual(g.map((x) => x.part), ['torso']);
});
