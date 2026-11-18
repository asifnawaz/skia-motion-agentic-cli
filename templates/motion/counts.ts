// counts.ts: motions that say how many, ported from the reels kit (word-quran-reels reels/_kit/numbers.js): a total rolling up
// (odometer), pieces arriving one at a time (drip), a streak's days filling (dayWall) and a pulse that goes on (beat). The reels
// draw with Canvas 2D; only the timing and layout math is here, as pure worklets that return plain numbers for a Skia drawing or
// a Reanimated style. Times are ms (the reels use seconds; the constants inside keep their reels values). Imports nothing.
//
// The owner's caps hold: a pulse is 0..1 and the CALLER scales it (at most 0.05 of the size, MOVE.overshootMax); nothing here
// overshoots, and a ring is one expanding stroke that fades, never a rebound.

/** Numbers from numbers.js, with the line each came from. */
export const COUNT = {
  /** drip: a piece falls at this acceleration in pt/s^2 (numbers.js line 46, accel = 3200), so 300 pt takes 0.43 s. */
  dripAccel: 3200,
  /** drip: the landing ring is gone 1.1 s after the landing (line 49). */
  dripRingMs: 1100,
  /** dayWall: a day's square arrives over 0.55 s before it lights (line 69). */
  dayArriveMs: 550,
  /** beat: lub-dub bpm of a calm pulse (line 148). */
  bpm: 70,
};

const clamp01 = (x: number) => {
  'worklet';
  return Math.min(1, Math.max(0, x));
};

/** The ease-out cubic of numbers.js line 7 (`easeOut`): starts at full speed. */
const cubicOut = (f: number) => {
  'worklet';
  return 1 - Math.pow(1 - f, 3);
};

/**
 * Use when a total rolls up from nothing (first appearance of a score): one digit strip, as odometer draws it (lines 24-26).
 * `d` is the settled digit, `di` its index from the left (0 = leftmost) of `digits` digits, `p` linear progress over the roll
 * (the reels use t0 -0.6 to t1 0.9 s, 1.5 s). The leftmost strip turns most (revs = digits - di; the reels' comment says the
 * rightmost is fastest but the code, ported as is, turns the leftmost most). Returns the digit on screen, the digit below it
 * and `offset`: how far (0..1) the strip is shifted toward the next one. Ease-out cubic starts at full speed: fine for a number
 * that appears, wrong for one that changes on screen (use `roll`, which eases in and out).
 */
export function odometerDigit(d: number, di: number, digits: number, p: number): { digit: number; next: number; offset: number } {
  'worklet';
  const revs = 1 + (digits - 1 - di);
  const v = (10 * revs + d) * cubicOut(clamp01(p));
  const b = Math.floor(v);
  return { digit: b % 10, next: (b + 1) % 10, offset: v - b };
}

/** When piece `i` of `n + 1` lands (numbers.js line 45): evenly from `t0` to `t1`, in ms. */
export function dripLand(i: number, t0: number, t1: number, n: number): number {
  'worklet';
  return t0 + ((t1 - t0) * i) / n;
}

/** How long a piece falls over `distance` pt, in ms: sqrt(2 d / a) (line 47). */
export function dripFall(distance: number, accel: number = COUNT.dripAccel): number {
  'worklet';
  return Math.sqrt((2 * distance) / accel) * 1000;
}

/**
 * Use when pieces arrive one at a time: pearls dropping into a purse, a year's ticks on a bar. Piece `i` of `n + 1` lands at
 * dripLand and falls from `fromY` to `toY` under `accel` (it accelerates, so it arrives fastest and the landing is the beat).
 * Returns phase 0 (not there), 1 (falling: `y`, `speed` in pt/s) or 2 (landed: `ring` grows 0..1 as 1 - e^(-6 a) and `fade` falls
 * 1..0 as e^(-3.2 a), a in seconds since the landing; draw the ring's radius as the reels' 150 pt x `ring`). Pair the landing
 * with `contact` on the target.
 */
export function drip(i: number, ms: number, t0: number, t1: number, n: number, fromY: number, toY: number, accel: number = COUNT.dripAccel): { phase: 0 | 1 | 2; y: number; speed: number; ring: number; fade: number } {
  'worklet';
  const fall = Math.sqrt((2 * (toY - fromY)) / accel);
  const tau = (ms - dripLand(i, t0, t1, n)) / 1000 + fall;
  if (tau < 0 || tau > fall + COUNT.dripRingMs / 1000) return { phase: 0, y: fromY, speed: 0, ring: 0, fade: 0 };
  if (tau <= fall) return { phase: 1, y: fromY + 0.5 * accel * tau * tau, speed: accel * tau, ring: 0, fade: 0 };
  const a = tau - fall;
  return { phase: 2, y: toY, speed: 0, ring: 1 - Math.exp(-6 * a), fade: Math.exp(-3.2 * a) };
}

/** Which day of `n` is filling at `ms` (dayWall line 65): the head, 0..n; the fill runs from `a` to `b` ms. */
export function dayHead(n: number, ms: number, a: number, b: number): number {
  'worklet';
  return Math.floor(n * clamp01((ms - a) / (b - a)));
}

/**
 * Use when days fill one square each: a streak, a calendar. Day `i` of `n` lights at its share of the fill window (a, b ms);
 * `cols` sets the breathing phase across the wall (a streak of seven is one row). Returns `arrive` 0..1 (the square flies in
 * from its own direction over the 0.55 s before it lights: ease-out cubic, 1 once there), `glow` (the brightness: a flash at the
 * lighting, then a slow settle to 0.3 with a small breath, numbers.js line 71) and `tone` 0 (new, gold), 1 (a day old) or 2.
 * Before the arrive window `arrive` and `glow` are 0. Not ported: the wall's dark days (line 71, a seeded 7 % that stay dark)
 * and its gaps and bursts, which are decoration of that reel.
 */
export function dayCell(i: number, n: number, cols: number, ms: number, a: number, b: number): { arrive: number; glow: number; tone: 0 | 1 | 2 } {
  'worklet';
  const t = ms / 1000;
  const age = t - (a / 1000 + ((b - a) / 1000) * (i / n));
  const arriveS = COUNT.dayArriveMs / 1000;
  if (age < -arriveS) return { arrive: 0, glow: 0, tone: 0 };
  const col = i % cols;
  const row = Math.floor(i / cols);
  const glow = age < 0 ? 0.95 * (1 + age / arriveS) : 0.3 + 0.22 * Math.exp(-age / 2.2) + 0.9 * Math.exp(-age * 2.6) + 0.1 * Math.sin(t * 2.2 - col * 0.09 + row * 0.05);
  const arrive = age < 0 ? cubicOut(1 + age / arriveS) : 1;
  return { arrive, glow, tone: age < 0 ? 0 : age > 4.5 ? 2 : age > 1.8 ? 1 : 0 };
}

/**
 * Use for a heart or a live pulse: the lub-dub of numbers.js line 148 at `bpm` from `t0` ms: 0..1, a first beat that decays
 * and a softer second at 0.3 of the period. Scale it by at most MOVE.overshootMax (the reels use 0.045) on a size, or by a ring.
 * 0 before `t0`.
 */
export function beat(ms: number, t0: number, bpm: number = COUNT.bpm): number {
  'worklet';
  if (ms < t0) return 0;
  const T = 60000 / bpm;
  const ph = ((ms - t0) % T) / T;
  return Math.min(1, Math.exp(-ph * 9) + (ph > 0.3 ? 0.65 * Math.exp(-(ph - 0.3) * 11) : 0));
}
