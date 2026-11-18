import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Golden test: templates/motion/follow.ts and counts.ts against Word Quran's reels kit (reels/_kit/dynamics.js and numbers.js),
// run live. Each port says which reels lines it came from; this compares them at several times to 1e-9. Skipped where the reels
// repository is not on disk; SKAC_REELS_KIT names its _kit folder. Deliberate differences are listed at the bottom.
const KIT = process.env.SKAC_REELS_KIT ?? '/media/whoami/linux-data/git/word-quran-reels/reels/_kit';
const have = existsSync(join(KIT, 'dynamics.js')) && existsSync(join(KIT, 'numbers.js'));
const opts = { skip: have ? false : `no reels kit at ${KIT}` };

const stub = (src) => 'data:text/javascript,' + encodeURIComponent(src);
const kitStub = stub('export const W = 1080, H = 1920, font = () => "", txt = () => ({ y0: 100, y1: 200 }), enter = (x) => 1 - Math.pow(1 - x, 3), seg = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));');
const libStub = stub('export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v)); export const mulberry = () => () => 0.5;');
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(spec, ctx, next) {
  if (spec === '/reels/_kit/kit.js') return { url: ${JSON.stringify(kitStub)}, shortCircuit: true };
  if (spec === '/core/lib.js') return { url: ${JSON.stringify(libStub)}, shortCircuit: true };
  try { return await next(spec, ctx); } catch (e) {
    if (spec.startsWith('.') && !/\\.\\w+$/.test(spec)) return next(spec + '.ts', ctx);
    throw e;
  }
}`), import.meta.url);

const F = await import('../../templates/motion/follow.ts');
const C = await import('../../templates/motion/counts.ts');
const M = await import('../../templates/motion/moves.ts');
const D = have ? await import(pathToFileURL(join(KIT, 'dynamics.js')).href) : null;
const N = have ? await import(pathToFileURL(join(KIT, 'numbers.js')).href) : null;
const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} != ${b}`);

test('follow: one home, and a spring from t = 0 that matches dynamics.js Follower (value and speed)', opts, () => {
  assert.equal(M.follow, F.follow, 'moves.ts re-exports the one follow');
  // a moving leader with a late step, so the spring is driven hard; the step sits off the 1/120 s grid
  const sec = (s) => 0.5 * Math.sin(3 * s) + (s > 0.4001 ? 1 : 0);
  for (const [omega, zeta, lead] of [[18, 0.8, 0.09], [14, 0.4, 0.1], [30, 0.62, 0]]) {
    const ref = new D.Follower((t) => ({ a: sec(t) }), { a: [omega, zeta] }, [14, 0.6], null, lead);
    const table = F.followTable((ms) => sec(ms / 1000), 2000, omega, zeta, lead * 1000);
    for (const t of [0, 0.004, 0.013, 0.2, 0.5, 0.9, 1.37, 1.99]) {
      const r = ref.at(t);
      near(F.follow(table, t * 1000), r.f.a, `value at ${t}, omega ${omega}`);
      near(F.followSpeed(table, t * 1000), r.v.a, `speed at ${t}, omega ${omega}`);
    }
  }
});

test('follow: the default spring overshoots a step by under 5 % and lags it by about MOVE.lagMs', () => {
  const step = (ms) => (ms >= 500 ? 1 : 0);
  const table = F.followTable(step, 2000, F.FOLLOW.omega, F.FOLLOW.zeta, 0);
  let peak = 0;
  for (let ms = 0; ms <= 2000; ms += 1) peak = Math.max(peak, F.follow(table, ms));
  assert.ok(peak > 1 && peak <= 1 + M.MOVE.overshootMax, `peak ${peak}`);
  const lag = 2 * F.FOLLOW.zeta / F.FOLLOW.omega * 1000; // the spring's time constant, ms
  assert.ok(Math.abs(lag - M.MOVE.lagMs) <= 5, `lag ${lag} ms against MOVE.lagMs ${M.MOVE.lagMs}`);
  assert.deepEqual(F.followTable(step, 300), F.followTable(step, 300), 'pure: the same table every time');
  near(F.follow(table, 1e6), F.follow(table, 2016), 'held after the table ends', 1e-6);
});

test('beat, dripLand and the drip fall match numbers.js (seconds there, ms here)', opts, () => {
  for (const bpm of [70, 52, 120]) {
    for (const t of [0, 0.3, 1.0, 1.41, 2.9, 7.77]) {
      near(C.beat(t * 1000, 500, bpm), N.beat(t, 0.5, bpm), `beat ${t} s at ${bpm}`);
    }
  }
  for (const [i, t0, t1, n] of [[0, 1, 4, 23], [7, 1.2, 3.9, 23], [23, 1, 4, 23], [3, 0.5, 2, 6]]) {
    near(C.dripLand(i, t0 * 1000, t1 * 1000, n) / 1000, N.dripLand(i, t0, t1, n), `dripLand ${i}`);
  }
});

/** The reels' drip drawn into a recorder: the y of each falling head (the glow's centre) and ring (the ellipse's radius). */
const reelsDrip = (t, cfg) => {
  const heads = [], rings = [];
  const grad = { addColorStop() {} };
  const g = {
    save() {}, restore() {}, beginPath() {}, stroke() {}, fillRect() {}, createLinearGradient: () => grad, createRadialGradient: (x, y) => { heads.push({ x, y }); return grad; },
    ellipse(x, y, rx) { rings.push({ x, rx }); },
  };
  N.drip(g, t, cfg);
  return { heads, rings };
};

test('drip: the falling head and the landing ring sit where numbers.js draws them', opts, () => {
  const cfg = { x0: 100, x1: 900, by: 1200, t0: 1, t1: 4, years: 12, fromY: 720, accel: 3200 };
  let nFall = 0, nLand = 0;
  for (const t of [0.5, 1.2, 1.6, 2.05, 2.6, 3.3, 4.2, 4.9]) {
    const ref = reelsDrip(t, cfg);
    const falling = [], landed = [];
    for (let i = 0; i <= cfg.years; i++) {
      const d = C.drip(i, t * 1000, cfg.t0 * 1000, cfg.t1 * 1000, cfg.years, cfg.fromY, cfg.by, cfg.accel);
      const x = cfg.x0 + ((cfg.x1 - cfg.x0) * i) / cfg.years;
      if (d.phase === 1) falling.push({ x, y: d.y });
      if (d.phase === 2) landed.push({ x, rx: 150 * d.ring });
    }
    // glow() is called twice per head (40 and 90 px), and once per spark; keep the heads' own y by their x
    const refHeads = ref.heads.filter((h) => falling.some((f) => f.x === h.x && Math.abs(f.y - h.y) < 1e-6));
    assert.equal(refHeads.length, 2 * falling.length, `heads at ${t} s`);
    falling.forEach((f) => assert.ok(ref.heads.some((h) => h.x === f.x && Math.abs(h.y - f.y) < 1e-9), `head y at ${t} s`));
    nFall += falling.length; nLand += landed.length;
    assert.equal(ref.rings.length, landed.length, `rings at ${t} s`);
    landed.forEach((l, k) => near(ref.rings[k].rx, l.rx, `ring radius at ${t} s`));
  }
  assert.ok(nFall >= 4 && nLand >= 4, `${nFall} falling heads and ${nLand} rings compared`);
  near(C.dripFall(480) / 1000, Math.sqrt(2 * 480 / 3200), 'dripFall');
});

/** The reels' dayWall drawn into a recorder: the filled rectangles of each brightness level, decoded from the fill style. */
const reelsWall = (t, cfg) => {
  const fills = [];
  let path = [];
  const grad = { addColorStop() {} };
  const g = {
    save() {}, restore() {}, fillRect() {}, createRadialGradient: () => grad, createLinearGradient: () => grad, beginPath() { path = []; },
    rect(x, y, w, h) { path.push({ x, y, w, h }); }, fill() { fills.push({ style: this.fillStyle, filter: this.filter, rects: path }); },
  };
  const out = N.dayWall(g, t, cfg, 600);
  const cells = new Map(); // day index -> level + 10 x tone, from the solid pass
  for (const f of fills.filter((x) => x.filter === 'none')) {
    const m = /rgba\((\d+),\d+,\d+,([\d.]+)\)/.exec(f.style);
    const tone = +m[1] > 200 ? 0 : +m[1] > 150 ? 1 : 2;
    const lv = Math.round(9 * Math.pow((+m[2] - 0.1) / 0.9, 1 / 1.1));
    for (const r of f.rects) cells.set(Math.round((r.x + r.w / 2 - 50) / 100 - 0.5), lv + 10 * tone);
  }
  return { head: out.head, cells };
};

test('dayWall: the head, and each lit day\'s brightness level and tone, match numbers.js', opts, () => {
  const n = 7, cols = 7;
  const cfg = { x0: 50, x1: 750, y0: 100, y1: 200, cols, rows: 1, N: n, unroll: [0, 1], fill: [2, 9] };
  const rnd = (i) => ((Math.imul(i + 11, 2654435761) >>> 8) % 1000) / 1000;
  let compared = 0;
  for (const t of [1.5, 2.4, 3.3, 4.1, 5.2, 6.6, 8.8, 11, 14]) {
    const ref = reelsWall(t, cfg);
    assert.equal(C.dayHead(n, t * 1000, 2000, 9000), ref.head, `head at ${t} s`);
    for (let i = 0; i < n; i++) {
      const c = C.dayCell(i, n, cols, t * 1000, 2000, 9000);
      const age = t - (2 + 7 * i / n);
      if (age < 0) { assert.ok(c.arrive < 1); continue; } // an arriving square is drawn offset from its slot: judged by its glow below
      assert.equal(c.arrive, 1);
      if (age > 0.3 && rnd(i * 17 + 3) < 0.07) continue; // the reels' dark days: not ported
      const lv = Math.max(0, Math.min(9, Math.round(c.glow * 7)));
      if (lv === 0) assert.ok(!ref.cells.has(i), `day ${i} at ${t} s is dark`);
      else assert.equal(ref.cells.get(i), lv + 10 * c.tone, `day ${i} at ${t} s`);
      compared++;
    }
  }
  assert.ok(compared >= 20, `${compared} lit days compared`);
  near(C.dayCell(0, n, cols, 2000 - 550, 2000, 9000).arrive, 0, 'arrive starts at 0');
  near(C.dayCell(0, n, cols, 2000, 2000, 9000).glow, 0.3 + 0.22 + 0.9 + 0.1 * Math.sin(4.4), 'glow at the lighting');
});

/** The reels' odometer drawn into a recorder: each digit's strip offset, from the first fillText of each digit. */
const reelsOdometer = (t, total, opts2) => {
  const calls = [];
  const g = {
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, measureText: (s) => ({ width: 10 * s.length }),
    fillText(ch, x, y) { calls.push({ ch, x, y }); },
  };
  N.odometer(g, 'n', total, { t, px: 100, maxW: 1e9, ...opts2 });
  const s = total.toLocaleString('en-US');
  const out = [];
  let k = 0;
  for (const ch of s) {
    if (ch < '0' || ch > '9') { k += 1; continue; }
    out.push({ digit: +calls[k].ch, next: +calls[k + 1].ch, offset: (200 - calls[k].y) / 98 }); // base = reg.y1 = 200, step = px x 0.98
    k += 2;
  }
  return out;
};

test('odometer: each digit strip matches numbers.js at every time; roll is deliberately different', opts, () => {
  const total = 1234567, digits = 7;
  for (const t of [-0.6, -0.2, 0, 0.3, 0.9, 1.5]) {
    const ref = reelsOdometer(t, total, { t0: -0.6, t1: 0.9 });
    const p = (t - -0.6) / 1.5;
    [...String(total)].forEach((d, di) => {
      const o = C.odometerDigit(+d, di, digits, p);
      assert.equal(o.digit, ref[di].digit, `digit ${di} at ${t}`);
      assert.equal(o.next, ref[di].next, `next ${di} at ${t}`);
      near(o.offset, ref[di].offset, `offset ${di} at ${t}`);
    });
  }
  // deliberate: roll eases in and out from the old value (a change on screen must not start at full speed), the odometer eases
  // out from nothing (a number that appears). Same end, different start.
  const r0 = M.roll(0, 1000, 0.1).value, o0 = 1000 * (1 - Math.pow(1 - 0.1, 3));
  assert.ok(r0 < o0 / 5, `roll starts slowly (${r0}) where the odometer starts fast (${o0})`);
  near(M.roll(0, 1000, 1).value, 1000, 'roll ends on the target');
});
