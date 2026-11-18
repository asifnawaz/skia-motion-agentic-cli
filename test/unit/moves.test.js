import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The templates import './motion' with no extension (Metro and Remotion resolve that); Node needs '.ts'.
const hook = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (spec.startsWith('.') && !/\\.\\w+$/.test(spec)) return next(spec + '.ts', ctx);
    throw e;
  }
}`;
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);

const M = await import('../../templates/motion/moves.ts');
const P = await import('../../templates/motion/points.ts');
const { MOVE } = M;
const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b}`);

test('MOVE numbers sit inside the binding rules', () => {
  assert.ok(MOVE.press >= 100 && MOVE.press <= 160);
  assert.ok(MOVE.feedback >= 150 && MOVE.feedback <= 250);
  assert.ok(MOVE.entrance >= 300 && MOVE.entrance <= 450);
  assert.ok(MOVE.handover >= 450 && MOVE.handover <= 700);
  assert.ok(MOVE.exitShare >= 0.65 && MOVE.exitShare <= 0.75);
  near(MOVE.exitMs, MOVE.entrance * MOVE.exitShare, 1);
  assert.ok(MOVE.fadeMax <= 250);
  assert.ok(MOVE.lagMs >= 60 && MOVE.lagMs <= 150);
  assert.ok(MOVE.overshootMax <= 0.05 && MOVE.contactSquash <= 0.08);
  assert.ok(MOVE.contactMs <= (6 / 30) * 1000);
});

test('carry: starts on from, ends on to, uniform scale unless reshape', () => {
  const a = { x: 10, y: 20, w: 100, h: 50 };
  const b = { x: 200, y: 300, w: 200, h: 100 };
  const c0 = M.carry(a, b, 0);
  const c1 = M.carry(a, b, 1);
  assert.deepEqual([c0.x, c0.y, c0.w, c0.h, c0.scale], [10, 20, 100, 50, 1]);
  for (const [k, v] of [['x', 200], ['y', 300], ['w', 200], ['h', 100], ['scale', 2]]) near(c1[k], v, 1e-6, k);
  const mid = M.carry(a, b, 0.5);
  near(mid.h / mid.w, 0.5, 1e-9); // aspect kept
  const r = M.carry(a, { ...b, h: 400 }, 1, { reshape: true });
  near(r.h, 400);
  assert.ok(M.carry(a, b, 0.5, { arc: 0 }).y !== M.carry(a, b, 0.5, { arc: 0.3 }).y); // the arc bows the path
});

test('morphBox: start, end and the radius travel', () => {
  const a = { x: 0, y: 0, w: 100, h: 40, r: 20 };
  const b = { x: 0, y: 200, w: 300, h: 500, r: 28 };
  assert.deepEqual(M.morphBox(a, b, 0), a);
  const e = M.morphBox(a, b, 1);
  for (const k of ['x', 'y', 'w', 'h', 'r']) near(e[k], b[k]);
  const m = M.morphBox(a, b, 0.5);
  assert.ok(m.r > 20 && m.r < 28);
});

test('press: 1 at rest, 0.97 down, back by MOVE.press with at most 1% overshoot', () => {
  near(M.press(0), 1);
  near(M.press(200), MOVE.pressScale, 1e-3);
  near(M.press(300, 0), MOVE.pressScale, 1e-3);
  let peak = 0;
  for (let ms = 0; ms <= 600; ms += 5) peak = Math.max(peak, M.press(300, ms));
  assert.ok(peak <= 1.01 + 1e-9, `overshoot ${peak}`);
  near(M.press(300, MOVE.press * 4), 1, 2e-3);
});

test('anticipate: 0 at both ends, a dip of -amount between', () => {
  near(M.anticipate(0, 8), 0);
  near(M.anticipate(1, 8), 0);
  near(M.anticipate(0.175, 8), -8);
});

test('settle: 0 to 1; overshoot capped at MOVE.overshootMax and zero by default', () => {
  near(M.settle(0), 0);
  near(M.settle(1), 1);
  near(M.settle(1, 0.5), 1);
  let peak = 0;
  let plain = 0;
  for (let p = 0; p <= 1; p += 0.005) {
    peak = Math.max(peak, M.settle(p, 0.5));
    plain = Math.max(plain, M.settle(p));
  }
  assert.ok(peak <= 1 + MOVE.overshootMax + 1e-9 && peak > 1.01, `peak ${peak}`);
  assert.ok(plain <= 1 + 1e-9, 'routine settle never overshoots');
});

test('follow: a child holds the leader\'s value when the leader is still, and trails it when it moves', () => {
  const still = M.followTable(() => 3, 500);
  near(M.follow(still, 250), 3);
  near(M.followSpeed(still, 250), 0);
  const ramp = M.followTable((ms) => ms, 1000, 18, 0.8, 0);
  assert.ok(M.follow(ramp, 500) < 500, 'a child behind a moving leader lags it');
});

test('staggerFrom: the cause starts first, then by distance, one gap apart', () => {
  const pos = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 300, y: 0 }];
  assert.equal(M.staggerFrom(1, pos, 1, 1000, 400), 600);
  assert.equal(M.staggerFrom(0, pos, 1, 1000, 400), 600 - MOVE.staggerMs);
  assert.equal(M.staggerFrom(2, pos, 1, 1000, 400), 600 - 2 * MOVE.staggerMs);
});

test('enter and exit: opacity finished by MOVE.fadeMax, scale and travel carry the rest', () => {
  const e0 = M.enter(0);
  assert.deepEqual([e0.scale, e0.opacity, e0.y], [MOVE.enterScale, 0, 12]);
  const e1 = M.enter(1);
  assert.deepEqual([e1.scale, e1.opacity, e1.y], [1, 1, 0]);
  near(M.enter(MOVE.fadeMax / MOVE.entrance).opacity, 1);
  assert.ok(M.enter(MOVE.fadeMax / MOVE.entrance).scale < 1, 'scale still moving when the fade is done');
  const x0 = M.exit(0);
  assert.deepEqual([x0.scale, x0.opacity, x0.y], [1, 1, 0]);
  const x1 = M.exit(1);
  near(x1.scale, MOVE.enterScale);
  near(x1.opacity, 0);
  near(M.exit(MOVE.fadeMax / MOVE.exitMs).opacity, 0);
  for (let p = 0; p <= 1; p += 0.01) {
    const o = M.enter(p).opacity;
    assert.ok(o >= 0 && o <= 1 + 1e-9);
  }
});

test('flyInto and contact: arrives on the target; squash within 6 percent, volume kept, back by contactMs', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 300, y: 400 };
  assert.deepEqual(M.flyInto(a, b, 0), { x: 0, y: 0, scale: 1 });
  const f = M.flyInto(a, b, 1);
  near(f.x, 300);
  near(f.y, 400);
  near(f.scale, 0.7);
  assert.deepEqual(M.contact(0), { sx: 1, sy: 1 });
  assert.deepEqual(M.contact(MOVE.contactMs), { sx: 1, sy: 1 });
  let low = 1;
  for (let ms = 1; ms < MOVE.contactMs; ms += 2) {
    const { sx, sy } = M.contact(ms);
    low = Math.min(low, sy);
    near(sx * Math.pow(sy, 0.6), 1, 1e-9, 'volume');
  }
  near(low, 1 - MOVE.contactSquash, 5e-3);
  assert.ok(M.contact(MOVE.contactMs - 1).sy > 0.999);
});

test('roll: value, digits and offsets at both ends, rightmost place fastest', () => {
  const r0 = M.roll(98, 103, 0);
  assert.equal(r0.value, 98);
  assert.deepEqual(r0.digits, [8, 9, 0]);
  const r1 = M.roll(98, 103, 1);
  assert.equal(r1.value, 103);
  assert.deepEqual(r1.digits, [3, 0, 1]);
  assert.deepEqual(r1.offsets, [0, 0, 0]);
  const mid = M.roll(0, 9, 0.5);
  assert.ok(mid.offsets[0] > 0 && mid.digits.length === 1);
  const r = M.roll(0, 100, 0.2);
  assert.ok(r.offsets[0] >= 0 && r.offsets[0] < 1);
});

test('revealRadius: 0 at p 0, the farthest corner at p 1', () => {
  const box = { x: 0, y: 0, w: 300, h: 400 };
  const o = { x: 0, y: 0 };
  assert.deepEqual(M.revealRadius(o, box, 0), { cx: 0, cy: 0, r: 0 });
  near(M.revealRadius(o, box, 1).r, 500);
  near(M.revealRadius({ x: 150, y: 200 }, box, 1).r, 250);
});

// ---- points.ts

const A = P.sortPoints([[10, 10], [60, 12], [110, 14], [160, 10], [10, 60], [60, 62]], 'x');
const B = P.sortPoints([[400, 300], [430, 330], [460, 300], [400, 360]], 'x');

test('sortPoints sorts a copy by x or y', () => {
  const src = [[3, 1], [1, 2], [2, 0]];
  assert.deepEqual(P.sortPoints(src, 'x').map((p) => p[0]), [1, 2, 3]);
  assert.deepEqual(P.sortPoints(src, 'y').map((p) => p[1]), [0, 1, 2]);
  assert.deepEqual(src[0], [3, 1]);
});

test('morphPoints: every path and stagger sits on A at p 0 and on B at p 1', () => {
  for (const path of P.MORPH_PATHS) {
    for (const stagger of ['x', 'y', 'rand', 'dist']) {
      const SA = P.sortPoints(A, stagger === 'y' ? 'y' : 'x');
      const SB = P.sortPoints(B, stagger === 'y' ? 'y' : 'x');
      const n = Math.max(SA.length, SB.length);
      const s = P.morphPoints(SA, SB, 0, { path, stagger });
      const e = P.morphPoints(SA, SB, 1, { path, stagger });
      assert.equal(s.length, n);
      for (let i = 0; i < n; i++) {
        const a = SA[Math.min(SA.length - 1, Math.floor((i * SA.length) / n))];
        const b = SB[Math.min(SB.length - 1, Math.floor((i * SB.length) / n))];
        near(s[i].x, a[0], 1e-6, `${path}/${stagger} start x`);
        near(s[i].y, a[1], 1e-6, `${path}/${stagger} start y`);
        near(e[i].x, b[0], 1e-6, `${path}/${stagger} end x`);
        near(e[i].y, b[1], 1e-6, `${path}/${stagger} end y`);
        near(s[i].size, 1);
        assert.ok(e[i].flash > 0 && e[i].flash <= 1);
      }
    }
  }
  assert.deepEqual(P.morphPoints([], B, 0.5), []);
});

test('morphPoints: size swells in flight; the far option scales the detours', () => {
  const mid = P.morphPoints(A, B, 0.4);
  assert.ok(mid.some((q) => q.size > 1.05) && mid.every((q) => q.size <= 1.5 + 1e-9));
  const small = P.morphPoints(A, B, 0.3, { path: 'lift', far: 100 });
  const big = P.morphPoints(A, B, 0.3, { path: 'lift', far: 2000 });
  assert.ok(small.some((q, i) => Math.abs(q.y - big[i].y) > 1));
});

const CTX = P.pointContext(P.sortPoints([...A, ...B], 'x'), 400);

test('pointContext: one context per point, shares in 0..1, far set', () => {
  assert.equal(CTX.length, A.length + B.length);
  for (const c of CTX) {
    assert.ok(c.gx >= 0 && c.gx <= 1 && c.gy >= 0 && c.gy <= 1 && c.rrN >= 0 && c.rrN <= 1 + 1e-9);
    assert.equal(c.far, 400);
  }
});

test('arrive: off screen at p 0, on target at p 1, for every style', () => {
  for (const style of P.ARRIVE_STYLES) {
    for (const c of CTX) {
      assert.equal(P.arrive(style, c, 0), null, `${style} p0`);
      const s = P.arrive(style, c, 1);
      near(s.x, c.tx, 1e-6, `${style} x`);
      near(s.y, c.ty, 1e-6, `${style} y`);
      near(s.size, 1, 1e-9, `${style} size`);
      assert.ok(s.landed);
    }
  }
});

test('arrive: drop rebounds once and burst overshoots at most 5%', () => {
  const c = CTX[0];
  let dips = 0;
  let prev = null;
  let goingUp = false;
  for (let p = 0; p <= 1.0001; p += 0.002) {
    const s = P.arrive('drop', c, Math.min(1, p));
    if (!s) continue;
    if (prev !== null) {
      if (s.y < prev - 1e-9) {
        if (!goingUp) dips++;
        goingUp = true;
      } else if (s.y > prev + 1e-9) goingUp = false;
    }
    prev = s.y;
  }
  assert.equal(dips, 1, 'exactly one rebound');
  const cc = CTX.find((q) => q.rr > 20);
  let worst = 0;
  for (let p = 0; p <= 1; p += 0.002) {
    const s = P.arrive('burst', cc, p);
    if (s) worst = Math.max(worst, Math.hypot(s.x - cc.cx, s.y - cc.cy) / cc.rr - 1);
  }
  assert.ok(worst <= 0.05 + 1e-6, `burst overshoot ${worst}`);
});

test('leave: on target at q 0, gone at q 1, for every style', () => {
  for (const style of P.LEAVE_STYLES) {
    for (const c of CTX) {
      const s = P.leave(style, c, 0);
      near(s.x, c.tx, 1e-6, `${style} x`);
      near(s.y, c.ty, 1e-6, `${style} y`);
      near(s.alpha, 1);
      near(P.leave(style, c, 1).alpha, 0, 1e-9, `${style} gone`);
    }
  }
  near(P.leave('reverse', CTX[0], 0, 'drop').y, CTX[0].ty, 1e-6);
});
