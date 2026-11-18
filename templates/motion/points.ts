// points.ts: point-cloud motion as pure worklets, ported from Word Quran's own reels kit (morph.js and
// pixelmotion.js, MIT in skac; see NOTICE.md). A shape or a word is a set of points; one set becomes
// another (morphPoints), arrives (arrive) or leaves (leave). Every function returns plain numbers per
// point; the drawing side is one canvas.drawPoints or a loop of drawRect in the scene's draw.ts.
// Imports only './motion'; every exported function is a worklet. `glitch` is dropped on purpose
// (it jumps; nothing shouts). Distances were written for a 1080 px frame: they scale with `far`,
// the travel distance the caller passes (default: the object's own diagonal).
import { CUBIC_IN, CUBIC_IN_OUT, CUBIC_OUT } from './motion';

export type P2 = readonly [number, number];
export type MorphPath = 'arc' | 'line' | 'spiral' | 'wave' | 'burst' | 'lift' | 'orbit';
export type Stagger = 'x' | 'y' | 'rand' | 'dist';
export type ArriveStyle = 'converge' | 'rain' | 'drop' | 'rise' | 'rows' | 'spiral' | 'vortex' | 'scan' | 'dissolve' | 'burst' | 'wave' | 'zoom' | 'arc';
export type LeaveStyle = 'reverse' | 'shatter' | 'vapor' | 'melt' | 'implode';
export const MORPH_PATHS: readonly MorphPath[] = ['arc', 'line', 'spiral', 'wave', 'burst', 'lift', 'orbit'];
export const ARRIVE_STYLES: readonly ArriveStyle[] = ['converge', 'rain', 'drop', 'rise', 'rows', 'spiral', 'vortex', 'scan', 'dissolve', 'burst', 'wave', 'zoom', 'arc'];
export const LEAVE_STYLES: readonly LeaveStyle[] = ['reverse', 'shatter', 'vapor', 'melt', 'implode'];

/** One point's state: where it is, `size` (a multiplier of the dot's base RADIUS: draw drawCircle(x, y, base * size)) and, for arrive/leave, alpha. */
export type MorphPoint = { x: number; y: number; size: number; flash: number };
export type PointState = { x: number; y: number; size: number; alpha: number; landed: boolean; flash: number };
/** What a point knows about itself (build with pointContext). k = far / 1000 scales fixed distances. */
export type PointCtx = {
  tx: number; ty: number; cx: number; cy: number; dx: number; dy: number; rr: number; rrN: number; ang0: number;
  gx: number; gy: number; row: number; r1: number; r2: number; r3: number; far: number; k: number;
};

const TAU = Math.PI * 2;
// Owner caps (O-5612 to O-5614): overshoot 5 % at most; one rebound on a landing.
const BURST_OVERSHOOT = 0.05;
const DROP_REBOUND = 0.1;
// morph.js timing: each point starts at 0.5 * rank + 0.12 * r2 and flies for 0.38 of the move.
const MORPH_RANK = 0.5;
const MORPH_JITTER = 0.12;
const MORPH_FLIGHT = 0.38;
const MORPH_FLASH_DECAY = 9;
// pixelmotion.js timing: start = 0.5 * rank + 0.15 * r1, flight (0.3 + 0.05 * r2) of the move.
const ARRIVE_RANK = 0.5;
const ARRIVE_JITTER = 0.15;

/** The reels' fixed random in [0, 1) (reels/_kit/morph.js rn), so a seed draws the same morph as the reels. */
const rn = (i: number) => {
  'worklet';
  return ((Math.imul(i + 11, 2654435761) >>> 8) % 1000) / 1000;
};
const lerp = (a: number, b: number, e: number) => {
  'worklet';
  return a + (b - a) * e;
};
const c01 = (x: number) => {
  'worklet';
  return Math.min(1, Math.max(0, x));
};

/** Sort a point set once, by x or y, so a stagger reads left to right or top to bottom. Run it outside the worklet. */
export function sortPoints(P: readonly P2[], by: 'x' | 'y'): P2[] {
  'worklet';
  const out = P.slice();
  if (by === 'y') out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  else out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out;
}

const bboxDiag = (A: readonly P2[], B: readonly P2[]) => {
  'worklet';
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const S of [A, B]) {
    for (let i = 0; i < S.length; i++) {
      x0 = Math.min(x0, S[i][0]);
      x1 = Math.max(x1, S[i][0]);
      y0 = Math.min(y0, S[i][1]);
      y1 = Math.max(y1, S[i][1]);
    }
  }
  return Math.max(1, Math.hypot(x1 - x0, y1 - y0));
};

const morphPose = (path: MorphPath, a: P2, b: P2, e: number, sg: number, r1: number, r2: number, k: number): P2 => {
  'worklet';
  switch (path) {
    case 'line':
      return [lerp(a[0], b[0], e), lerp(a[1], b[1], e)];
    case 'arc': {
      const mx = (a[0] + b[0]) / 2 + (a[1] - b[1]) * 0.3 * sg;
      const my = (a[1] + b[1]) / 2 - (a[0] - b[0]) * 0.3 * sg - 70 * k;
      const u = 1 - e;
      return [u * u * a[0] + 2 * u * e * mx + e * e * b[0], u * u * a[1] + 2 * u * e * my + e * e * b[1]];
    }
    case 'spiral': {
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      const ang = Math.sin(Math.PI * e) * 2.6 * sg; // 0 at both ends: the reels' version started turned, off A
      const co = Math.cos(ang);
      const si = Math.sin(ang);
      const vx = lerp(a[0] - mx, b[0] - mx, e);
      const vy = lerp(a[1] - my, b[1] - my, e);
      return [mx + vx * co - vy * si, my + vx * si + vy * co];
    }
    case 'wave': {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) + 1;
      const w = Math.sin(e * TAU + r1 * 6) * 40 * k * (1 - Math.abs(2 * e - 1));
      return [lerp(a[0], b[0], e) - (dy / L) * w, lerp(a[1], b[1], e) + (dx / L) * w];
    }
    case 'burst': {
      const ox = (a[0] + b[0]) / 2 + Math.cos(r1 * TAU) * 210 * k;
      const oy = (a[1] + b[1]) / 2 + Math.sin(r1 * TAU) * 160 * k;
      const u = 1 - e;
      return [u * u * a[0] + 2 * u * e * ox + e * e * b[0], u * u * a[1] + 2 * u * e * oy + e * e * b[1]];
    }
    case 'lift':
      return [lerp(a[0], b[0], e), lerp(a[1], b[1], e) - Math.sin(Math.PI * e) * 220 * k];
    default: {
      // orbit
      const cx = (a[0] + b[0]) / 2;
      const cy = (a[1] + b[1]) / 2;
      const ra = Math.hypot(a[0] - cx, a[1] - cy);
      const rb = Math.hypot(b[0] - cx, b[1] - cy);
      const aa = Math.atan2(a[1] - cy, a[0] - cx);
      const ab = Math.atan2(b[1] - cy, b[0] - cx);
      let d = ab - aa;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      const an = aa + d * e + Math.sin(Math.PI * e) * 3 * sg; // 0 at both ends (the reels' version started off A)
      const r = lerp(ra, rb, e);
      return [cx + Math.cos(an) * r, cy + Math.sin(an) * r];
    }
  }
};

/**
 * Use when one word, numeral or shape made of points becomes another: the points of A travel to B (a word
 * to a numeral, a heart to a word). p 0 sits on A, p 1 on B; a landed point flashes (flash 1 to 0).
 * `A` and `B` must be sorted with sortPoints by the same key as `stagger` ('y' sorts by y, the others by
 * x), once, outside the worklet. Point counts may differ. `size` multiplies the dot's base radius
 * (1 to 1.5 in flight): draw `canvas.drawCircle(x, y, base * size, paint)`; for square dots use 2 * base * size as the side. opts.far scales the fixed distances (default: the two sets' diagonal).
 * Over MOVE.handover or longer (a morph of many points reads at 700 to 1200 ms).
 */
export function morphPoints(A: readonly P2[], B: readonly P2[], p: number, opts?: { path?: MorphPath; stagger?: Stagger; seed?: number; far?: number }): MorphPoint[] {
  'worklet';
  const out: MorphPoint[] = [];
  const nA = A.length;
  const nB = B.length;
  if (!nA || !nB) return out;
  const path = (opts && opts.path) || 'arc';
  const stagger = (opts && opts.stagger) || 'x';
  const seed = opts && opts.seed !== undefined ? opts.seed : 1;
  const k = ((opts && opts.far) || bboxDiag(A, B)) / 1000;
  const n = Math.max(nA, nB);
  const by = stagger === 'y' ? 1 : 0;
  const lo = Math.min(A[0][by], B[0][by]);
  const hi = Math.max(A[nA - 1][by], B[nB - 1][by]) + 1;
  for (let i = 0; i < n; i++) {
    const a = A[Math.min(nA - 1, Math.floor((i * nA) / n))];
    const b = B[Math.min(nB - 1, Math.floor((i * nB) / n))];
    const r1 = rn(i * 3 + seed);
    const r2 = rn(i * 5 + seed + 1);
    const sg = r1 > 0.5 ? 1 : -1;
    let rank: number;
    if (stagger === 'rand') rank = r2;
    else if (stagger === 'dist') rank = c01(Math.hypot(a[0] - b[0], a[1] - b[1]) / (900 * k));
    else rank = c01((a[by] - lo) / (hi - lo));
    const start = MORPH_RANK * rank + MORPH_JITTER * r2;
    const tau = c01((p - start) / MORPH_FLIGHT);
    const e = CUBIC_IN_OUT(tau);
    const pos = morphPose(path, a, b, e, sg, r1, r2, k);
    out.push({ x: pos[0], y: pos[1], size: 1 + 0.5 * Math.sin(Math.PI * e), flash: tau >= 1 ? Math.exp(-(p - start - MORPH_FLIGHT) * MORPH_FLASH_DECAY) : 0 });
  }
  return out;
}

/**
 * Build each point's context for arrive() and leave(): its target, the object's centre, polar position,
 * share across the object (gx, gy 0..1), a row band, three seeded randoms and the travel `far`
 * (default: the object's diagonal). Run it once, outside the worklet.
 */
export function pointContext(P: readonly P2[], far?: number): PointCtx[] {
  'worklet';
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < P.length; i++) {
    x0 = Math.min(x0, P[i][0]);
    x1 = Math.max(x1, P[i][0]);
    y0 = Math.min(y0, P[i][1]);
    y1 = Math.max(y1, P[i][1]);
  }
  const diag = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
  const f = far || diag;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  let rmax = 1;
  for (let i = 0; i < P.length; i++) rmax = Math.max(rmax, Math.hypot(P[i][0] - cx, P[i][1] - cy));
  const out: PointCtx[] = [];
  for (let i = 0; i < P.length; i++) {
    const dx = P[i][0] - cx;
    const dy = P[i][1] - cy;
    const rr = Math.hypot(dx, dy);
    const gy = (P[i][1] - y0) / h;
    out.push({
      tx: P[i][0], ty: P[i][1], cx, cy, dx, dy, rr, rrN: rr / rmax, ang0: Math.atan2(dy, dx),
      gx: (P[i][0] - x0) / w, gy, row: Math.floor((P[i][1] - y0) / (f / 48)),
      r1: rn(i * 3 + 1), r2: rn(i * 5 + 2), r3: rn(i * 7 + 3), far: f, k: f / 1000,
    });
  }
  return out;
}

const dist = (c: PointCtx) => {
  'worklet';
  return c.far * (0.45 + 0.9 * c.r1);
};

/** Capped back-ease: CUBIC_OUT with one overshoot of at most 5 % that ends at exactly 1. */
const easeBackCapped = (f: number) => {
  'worklet';
  return CUBIC_OUT(f) + BURST_OVERSHOOT * Math.sin(Math.PI * c01((f - 0.5) / 0.5));
};

/** A fall with one rebound: down by 0.7 of the move, up DROP_REBOUND of the fall, down again. Ends at 1. */
const easeDropOnce = (f: number) => {
  'worklet';
  if (f < 0.7) {
    const q = f / 0.7;
    return q * q;
  }
  const r = (f - 0.7) / 0.3;
  return 1 - DROP_REBOUND * 4 * r * (1 - r);
};

const styleRank = (s: ArriveStyle, c: PointCtx): number => {
  'worklet';
  switch (s) {
    case 'converge': return (c.ang0 + Math.PI) / TAU;
    case 'rain': return 0.8 * c.gx + 0.2 * c.r1;
    case 'drop': return 0.7 * (1 - c.gy) + 0.3 * c.r1;
    case 'rise': return 1 - c.gy;
    case 'rows': return c.gy;
    case 'spiral': return c.rrN;
    case 'vortex': return c.r1;
    case 'scan': return c.gy;
    case 'dissolve': return c.r1;
    case 'burst': return c.rrN;
    case 'wave': return c.gx;
    case 'zoom': return c.r1;
    default: return c.gx; // arc
  }
};

/** Flight share of the move per style (scan and dissolve resolve quickly). */
const styleSpan = (s: ArriveStyle) => {
  'worklet';
  return s === 'scan' ? 0.2 : s === 'dissolve' ? 0.25 : 1;
};

const styleEase = (s: ArriveStyle, f: number): number => {
  'worklet';
  if (s === 'rain') return 1 - (1 - f) * (1 - f);
  if (s === 'drop') return easeDropOnce(f);
  if (s === 'burst') return easeBackCapped(f);
  return CUBIC_OUT(f);
};

const stylePose = (s: ArriveStyle, c: PointCtx, e: number): P2 => {
  'worklet';
  const k = c.k;
  switch (s) {
    case 'converge': {
      const a = c.ang0 + (c.r2 - 0.5) * 0.7;
      const d = dist(c) * (1 - e);
      return [c.tx + Math.cos(a) * d, c.ty + Math.sin(a) * d];
    }
    case 'rain': return [c.tx + (c.r2 - 0.5) * 16 * k * (1 - e), c.ty - dist(c) * 1.3 * (1 - e)];
    case 'drop': return [c.tx, c.ty - dist(c) * 1.1 * (1 - e)];
    case 'rise': return [c.tx + Math.sin(c.r2 * 6 + e * 9) * 22 * k * (1 - e), c.ty + dist(c) * (1 - e)];
    case 'rows': return [c.tx + (c.row % 2 ? 1 : -1) * (650 + 450 * c.r1) * k * (1 - e), c.ty];
    case 'spiral': {
      const a = c.ang0 + (1 - e) * 5.6;
      const r = c.rr + dist(c) * 0.9 * (1 - e);
      return [c.cx + Math.cos(a) * r, c.cy + Math.sin(a) * r];
    }
    case 'vortex': {
      const R = c.rr + c.far * 0.85 * (1 - e);
      const a = c.ang0 + (1 - e) * (3.5 + 3 * c.r2) * (c.r3 > 0.5 ? 1 : -1);
      return [c.cx + Math.cos(a) * R, c.cy + Math.sin(a) * R * (0.7 + 0.3 * e)]; // the ring flattens, then lands round
    }
    case 'scan':
    case 'dissolve': return [c.tx, c.ty];
    case 'burst': return [c.cx + c.dx * e, c.cy + c.dy * e];
    case 'wave': return [c.tx, c.ty + Math.sin(c.gx * 9 + e * 6) * 170 * k * (1 - e)];
    case 'zoom': return [c.cx + c.dx * (1 + 2.4 * (1 - e)), c.cy + c.dy * (1 + 2.4 * (1 - e))];
    default: {
      // arc
      const sx = c.tx + (c.r3 > 0.5 ? -1 : 1) * 900 * k;
      const sy = c.ty + (c.r2 - 0.5) * 900 * k;
      const mx = (sx + c.tx) / 2 + (c.ty - sy) * 0.45;
      const my = (sy + c.ty) / 2 - (c.tx - sx) * 0.45;
      const u = 1 - e;
      return [u * u * sx + 2 * u * e * mx + e * e * c.tx, u * u * sy + 2 * u * e * my + e * e * c.ty];
    }
  }
};

const styleSize = (s: ArriveStyle, c: PointCtx, e: number) => {
  'worklet';
  if (s === 'scan') return 1 + 1.6 * (1 - e);
  if (s === 'dissolve') return 1 + 1.4 * (1 - e) * c.r2;
  if (s === 'zoom') return 1 + 3 * (1 - e);
  return 1 + 1.6 * (1 - e) * (1 - c.r2);
};

const styleAlpha = (s: ArriveStyle, tau: number) => {
  'worklet';
  if (s === 'scan') return c01(tau * 4);
  if (s === 'dissolve') return c01(tau * 5);
  if (s === 'zoom') return c01(tau * 2.2) * 0.8;
  return c01(tau * 3);
};

/**
 * Use when a set of points appears (a word, an outline, a numeral): p 0..1 over MOVE.handover or longer.
 * Returns null while the point is not on screen yet (always at p = 0), and its state after: p 1 sits on
 * its target (ctx.tx, ctx.ty) at size 1, alpha 1. Thirteen styles, none shouting; `drop` rebounds once
 * and `burst` overshoots at most 5 %. Pick one per object so no two objects move alike.
 */
export function arrive(style: ArriveStyle, ctx: PointCtx, p: number): PointState | null {
  'worklet';
  const start = ARRIVE_RANK * c01(styleRank(style, ctx)) + ARRIVE_JITTER * ctx.r1;
  const flight = (0.3 + 0.05 * ctx.r2) * styleSpan(style);
  const tau = c01((p - start) / flight);
  if (tau <= 0) return null;
  const e = styleEase(style, tau);
  const pos = stylePose(style, ctx, e);
  const landed = tau >= 1;
  return { x: pos[0], y: pos[1], size: styleSize(style, ctx, e), alpha: styleAlpha(style, tau), landed, flash: landed ? Math.exp(-(p - start - flight) * MORPH_FLASH_DECAY) : 0 };
};

/**
 * Use when a set of points goes away: q 0..1. q 0 sits on the target; q 1 has every point gone (alpha 0).
 * `reverse` replays the arrival backwards (pass the style the set arrived with as `arrived`); the others
 * are shatter (outward with gravity), vapor (up, swaying), melt (down) and implode (into the centre).
 */
export function leave(style: LeaveStyle, ctx: PointCtx, q: number, arrived: ArriveStyle = 'converge'): PointState {
  'worklet';
  const qt = c01((q - 0.35 * ctx.r2) / 0.65);
  const k = ctx.k;
  let x = ctx.tx;
  let y = ctx.ty;
  let size = 1;
  let alpha = 1 - qt;
  if (style === 'shatter') {
    const a = ctx.ang0 + (ctx.r2 - 0.5) * 1.2;
    const d = dist(ctx) * qt * qt;
    x = ctx.tx + Math.cos(a) * d;
    y = ctx.ty + Math.sin(a) * d + 700 * k * qt * qt * (0.4 + ctx.r3);
    size = 1 - 0.4 * qt;
  } else if (style === 'vapor') {
    x = ctx.tx + Math.sin(qt * 8 + ctx.r2 * 6) * 46 * k * qt;
    y = ctx.ty - 300 * k * qt * (0.4 + ctx.r1);
    size = 1 + 0.6 * qt;
    alpha = (1 - qt) * (1 - 0.4 * qt);
  } else if (style === 'melt') {
    x = ctx.tx + Math.sin(ctx.r3 * 6) * 9 * k * qt;
    y = ctx.ty + 560 * k * qt * qt * (0.3 + ctx.r1);
    size = 1 - 0.3 * qt;
  } else if (style === 'implode') {
    x = ctx.tx + (ctx.cx - ctx.tx) * qt * qt;
    y = ctx.ty + (ctx.cy - ctx.ty) * qt * qt;
    size = 1 - 0.7 * qt;
    alpha = 1 - qt * qt;
  } else {
    // reverse: the arrival played backwards (ease-in on the way out, never ease-out)
    const e = styleEase(arrived, 1 - CUBIC_IN(qt));
    const pos = stylePose(arrived, ctx, e);
    x = pos[0];
    y = pos[1];
    size = styleSize(arrived, ctx, e);
  }
  return { x, y, size, alpha, landed: false, flash: 0 };
};
