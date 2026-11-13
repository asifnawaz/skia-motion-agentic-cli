// motion.ts: the motion engine for Skia drawings (adapted from rossark-motion-skill
// templates/react-native/motion.ts, MIT; the cubic-bezier solver from huashu-art-motion
// scripts/engine/lib/motion.js MO.bezier, MIT. See NOTICE.md at the package root).
//
// HOW IT RUNS IN BOTH PLACES
// - This file imports nothing. Every function is a pure function of time `t` in milliseconds
//   and carries a 'worklet' directive, so the same file runs:
//   * in the app, on the UI thread, inside Reanimated `useDerivedValue` (clock from clock.app.ts);
//   * in Remotion, during React render, with `t = frame / fps * 1000` (clock from clock.remotion.ts).
// - The 'worklet' string is a no-op outside Reanimated's Babel plugin.
// - Keep every curve constant at the TOP of the module: a worklet captures what it references
//   when it is created, and constants declared further down are undefined inside it (rossark §8).

/** A cubic-bezier easing p (0..1) -> 0..1, like CSS cubic-bezier(x1, y1, x2, y2). */
export function bezier(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  'worklet';
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  return (p: number) => {
    'worklet';
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let s = p;
    for (let k = 0; k < 8; k++) {
      const e = ((ax * s + bx) * s + cx) * s - p;
      const d = (3 * ax * s + 2 * bx) * s + cx;
      if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break;
      s -= e / d;
    }
    s = Math.min(1, Math.max(0, s));
    return ((ay * s + by) * s + cy) * s;
  };
}

/** Things that travel: gaze, sway, a head turning, a lid closing (rossark §2). */
export const EASE_IN_OUT = bezier(0.77, 0, 0.175, 1);
/** Things that open or arrive: a mouth, a lid reopening, a prop appearing (rossark §2). */
export const EASE_OUT = bezier(0.23, 1, 0.32, 1);
/** Only things leaving or falling away. Never something the eye is waiting on (rossark §2). */
export const EASE_IN = bezier(0.55, 0, 1, 0.45);

/** A keyframe: time (ms), value, and the curve of the segment ARRIVING here ('out', or ease-in-out). */
export type Key = readonly [number, number, 'out'?];
export type Keys = readonly Key[];
/** A key pose for `flow`: time (ms) and value, sorted by time. */
export type FlowKey = readonly [number, number];
export type FlowKeys = readonly FlowKey[];

/**
 * One move (a blink, a lid, a door): eases into and out of EVERY key, so it stops at each.
 * The last key should equal the first in a loop, so the seam never jumps (rossark §2).
 */
export function track(t: number, keys: Keys): number {
  'worklet';
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const k1 = keys[i];
    if (t <= k1[0]) {
      const k0 = keys[i - 1];
      const span = k1[0] - k0[0];
      const p = span > 0 ? (t - k0[0]) / span : 1;
      const e = k1[2] === 'out' ? EASE_OUT(p) : EASE_IN_OUT(p);
      return k0[1] + (k1[1] - k0[1]) * e;
    }
  }
  return keys[keys.length - 1][1];
}

/**
 * A chain of poses (a body, wings, a head turn): passes through every key with a continuous
 * speed and never overshoots one (a monotone cubic). Repeat a value to hold; the idle layer
 * keeps the hold moving (rossark §5.1).
 */
export function flow(t: number, k: FlowKeys): number {
  'worklet';
  const n = k.length;
  if (t <= k[0][0]) return k[0][1];
  if (t >= k[n - 1][0]) return k[n - 1][1];
  let i = 0;
  while (k[i + 1][0] < t) i++;
  const slope = (j: number) => {
    'worklet';
    return (k[j + 1][1] - k[j][1]) / (k[j + 1][0] - k[j][0]);
  };
  const tangent = (j: number) => {
    'worklet';
    if (j === 0 || j === n - 1) return 0;
    const a = slope(j - 1);
    const b = slope(j);
    if (a * b <= 0) return 0;
    const h0 = k[j][0] - k[j - 1][0];
    const h1 = k[j + 1][0] - k[j][0];
    const w0 = 2 * h1 + h0;
    const w1 = h1 + 2 * h0;
    return (w0 + w1) / (w0 / a + w1 / b);
  };
  const h = k[i + 1][0] - k[i][0];
  const s = (t - k[i][0]) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * k[i][1] + (s3 - 2 * s2 + s) * h * tangent(i) + (-2 * s3 + 3 * s2) * k[i + 1][1] + (s3 - s2) * h * tangent(i + 1);
}

/** 0 -> 1 inside the window [a, b], eased; 0 before, 1 after. One beat of a scene (rossark §2). */
export function seg(t: number, a: number, b: number, curve: 'out' | 'inOut' = 'out'): number {
  'worklet';
  if (t <= a) return 0;
  if (t >= b) return 1;
  const p = (t - a) / (b - a);
  return curve === 'out' ? EASE_OUT(p) : EASE_IN_OUT(p);
}

/** An accent's envelope: rises over `ramp` after a, falls over `ramp` before b. Gate a wave with it. */
export function env(t: number, a: number, b: number, ramp: number): number {
  'worklet';
  return seg(t, a, a + ramp, 'inOut') * (1 - seg(t, b - ramp, b, 'inOut'));
}

/** A smooth back-and-forth, -1..1. `phase` (0..1) offsets one item from the next (rossark §2). */
export function wave(t: number, period: number, phase = 0): number {
  'worklet';
  return Math.sin((t / period + phase) * Math.PI * 2);
}

/** Progress through a loop, 0..1, with a phase: drifting or falling items (rossark §2). */
export function loop(t: number, period: number, phase = 0): number {
  'worklet';
  const p = (t / period + phase) % 1;
  return p < 0 ? p + 1 : p;
}

/** 0 at both ends and 1 in the middle: fade in and out (steam, sparkles, ripples) (rossark §2). */
export function bell(p: number): number {
  'worklet';
  return Math.sin(Math.PI * Math.min(1, Math.max(0, p)));
}

/** A stable pseudo-random number in [0, 1) for item i. Never Math.random() per frame (rossark §1.6). */
export function seeded(i: number, salt = 0): number {
  'worklet';
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Gravity hop over the window [a, b] (ms) to height `top`: lift = top * (1 - k^2), k from -1 to 1.
 * Peak speed is at take-off and contact: 4 * top / (b - a) units per ms (rossark §5.8).
 */
export function hop(t: number, a: number, b: number, top: number): number {
  'worklet';
  if (t <= a || t >= b) return 0;
  const k = ((t - a) / (b - a)) * 2 - 1;
  return top * (1 - k * k);
}

/** 0 at the top of a hop, 1 at take-off and contact: drives the air stretch (rossark §5.8). */
export function hopStretch(t: number, a: number, b: number): number {
  'worklet';
  if (t <= a || t >= b) return 0;
  return Math.abs(((t - a) / (b - a)) * 2 - 1);
}

/** Keep the volume: when the height scales by sy, the width scales by 1 / sy^0.6 (rossark §5.9). */
export function keepVolume(sy: number): number {
  'worklet';
  return 1 / Math.pow(sy, 0.6);
}

/**
 * A damped spring's step response, 0 -> 1 (may pass 1 = overshoot), t in ms.
 * duration = one natural period; bounce 0 = critically damped (no overshoot), 0.15 ~ 2.5 %,
 * 0.3 ~ 10 % (huashu motion.js MO.spring, SwiftUI parameters). Use only for a contact rebound
 * (one overshoot, then settle) or interface moves; parts follow by delay, not springs (rossark §5.4).
 */
export function spring(t: number, duration = 500, bounce = 0): number {
  'worklet';
  if (t <= 0) return 0;
  const s = t / 1000;
  const w = (2 * Math.PI) / (duration / 1000);
  const z = 1 - bounce;
  if (Math.abs(z - 1) < 1e-4) return 1 - Math.exp(-w * s) * (1 + w * s);
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * s) * (Math.cos(wd * s) + ((z * w) / wd) * Math.sin(wd * s));
}

/** Degrees to radians: Skia's `rotate` takes radians. */
export const DEG = Math.PI / 180;
