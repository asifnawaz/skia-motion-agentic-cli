// moves.ts: interface moves as pure worklets. An agent animating a card, a button or a screen change calls a
// move here instead of writing a fade. Every move returns plain numbers, so it drives a Skia drawing or a
// Reanimated View style alike, and `skac --check` reads them as channels (`<element><Field>`, see
// `skac docs motion/interface`). Imports './motion' and re-exports './follow'; every exported function is a worklet.
import { CUBIC_IN_OUT, EASE_IN, EASE_IN_OUT, EASE_OUT, keepVolume, spring } from './motion';

// The hand-over curve lives in motion.ts (one home); re-exported here because every move below takes it.
export { CUBIC_IN_OUT };
// Follow-through lives in follow.ts (one home): a damped spring from the reels kit's Follower, `follow(table, ms)`.
export { FOLLOW, follow, followSpeed, followTable } from './follow';
// Counts and pulses (a drip, a day wall, a beat, a rolling total) live in counts.ts, ported from the reels kit's numbers.js.

/** Every number a move uses, with its source. Times in ms. Change a number here, never inside a move. */
export const MOVE = {
  /** Press-and-release feedback. rossark §7: 100 to 160 ms. */
  press: 130,
  /** Feedback lands 150 to 250 ms after its trigger (motion standard). */
  feedback: 200,
  /** An entrance takes 300 to 450 ms (motion standard). */
  entrance: 380,
  /** A hand-over (card to screen, button to sheet) takes 450 to 700 ms (motion standard). */
  handover: 560,
  /** An exit lasts 0.7 of the entrance (65 to 75 %, motion standard). */
  exitShare: 0.7,
  /** entrance x exitShare, rounded. */
  exitMs: 266,
  /** Fades: at most 0.25 s, never on the subject (motion standard 4). */
  fadeMax: 250,
  /** A child part reads its parent 60 to 150 ms earlier (rossark rule 4); FOLLOW's spring lags 89 ms and reads 90 ms ahead. */
  lagMs: 90,
  /** Items of a list start 40 to 80 ms apart (rossark). */
  staggerMs: 60,
  /** Overshoot at most 5 % (owner: "overshoot 5% at most, one rebound on a landing"). */
  overshootMax: 0.05,
  /** A pressable thing scales to about 0.97 on press (rossark §7). */
  pressScale: 0.97,
  /** An entrance starts from a scale of 0.9 to 0.97 (principles §5). */
  enterScale: 0.94,
  /** Squash and stretch only on contact, within about 8 % (motion standard). */
  contactSquash: 0.06,
  /** ...and back within 6 frames at 30 fps (motion standard). */
  contactMs: 200,
};

export type Pt = { x: number; y: number };
/** A box by its top-left corner. */
export type Box = { x: number; y: number; w: number; h: number };
export type RoundBox = Box & { r: number };

const lerp = (a: number, b: number, e: number) => {
  'worklet';
  return a + (b - a) * e;
};
const clamp01 = (x: number) => {
  'worklet';
  return Math.min(1, Math.max(0, x));
};

/**
 * Use when one element goes from here to there: a list card into its detail frame, a tile into a slot.
 * `p` is LINEAR progress (0..1 of the move's window); carry eases it inside with CUBIC_IN_OUT, so never pass
 * an eased p. The centre travels a slight arc (opts.arc, default 0.08 of the distance; 0 for a straight carry), and the box
 * scales uniformly (opts.reshape: true lets w and h change on their own). Over MOVE.handover (560 ms).
 * Not for a swap of two different things: that needs a carry for each, never a crossfade.
 */
export function carry(from: Box, to: Box, p: number, opts?: { arc?: number; reshape?: boolean }): Box & { scale: number } {
  'worklet';
  const e = CUBIC_IN_OUT(p);
  const arc = opts && opts.arc !== undefined ? opts.arc : 0.08;
  const fx = from.x + from.w / 2;
  const fy = from.y + from.h / 2;
  const tx = to.x + to.w / 2;
  const ty = to.y + to.h / 2;
  const dx = tx - fx;
  const dy = ty - fy;
  const d = Math.sqrt(dx * dx + dy * dy);
  const bow = d > 0 ? arc * d * Math.sin(Math.PI * e) : 0;
  const cx = lerp(fx, tx, e) + (d > 0 ? (-dy / d) * bow : 0);
  const cy = lerp(fy, ty, e) + (d > 0 ? (dx / d) * bow : 0);
  let w: number;
  let h: number;
  let scale: number;
  if (opts && opts.reshape) {
    w = lerp(from.w, to.w, e);
    h = lerp(from.h, to.h, e);
    scale = from.w > 0 ? w / from.w : 1;
  } else {
    scale = lerp(1, from.w > 0 ? to.w / from.w : 1, e);
    w = from.w * scale;
    h = from.h * scale;
  }
  return { x: cx - w / 2, y: cy - h / 2, w, h, scale };
}

/**
 * Use when a shape becomes another shape: a button into a sheet, a chip into a card. Position, size and
 * corner radius all travel together on CUBIC_IN_OUT, so it is one object, not two. Over MOVE.handover.
 * `p` is linear progress; the curve is applied inside.
 */
export function morphBox(from: RoundBox, to: RoundBox, p: number): RoundBox {
  'worklet';
  const e = CUBIC_IN_OUT(p);
  return { x: lerp(from.x, to.x, e), y: lerp(from.y, to.y, e), w: lerp(from.w, to.w, e), h: lerp(from.h, to.h, e), r: lerp(from.r, to.r, e) };
}

/** Press-down value (scale) at `ms` after touch-down: MOVE.pressScale reached in about 60 ms. */
const pressDown = (ms: number) => {
  'worklet';
  return 1 - (1 - MOVE.pressScale) * EASE_OUT(clamp01(ms / 60));
};

/**
 * Use on anything pressable: returns its scale. Down: to MOVE.pressScale (0.97) in about 60 ms. Up: back to 1
 * over MOVE.press (130 ms) with at most 1 % overshoot. `msSinceUp` is omitted or negative while held.
 */
export function press(msSinceDown: number, msSinceUp?: number): number {
  'worklet';
  if (msSinceUp === undefined || msSinceUp < 0) return pressDown(msSinceDown);
  const from = pressDown(msSinceDown - msSinceUp);
  return Math.min(1.01, from + (1 - from) * spring(msSinceUp, MOVE.press, 0.3));
}

/**
 * For earned moments only (a reward, a first success), never routine changes: a small dip against the move
 * before it starts. Returns 0 at both ends and -amount at its deepest; add it to the move's value.
 * p is progress over the first 35 % of the move; hold at 0 outside it.
 */
export function anticipate(p: number, amount: number): number {
  'worklet';
  const q = clamp01(p / 0.35);
  return -amount * Math.sin(Math.PI * q);
}

/**
 * Easing for any value that must arrive and stay: 0 to 1 with EASE_OUT. Routine changes keep overshoot 0.
 * An earned arrival may pass 1 once, by `overshoot` capped at MOVE.overshootMax (5 %), and ends at exactly 1.
 */
export function settle(p: number, overshoot = 0): number {
  'worklet';
  const q = clamp01(p);
  const base = EASE_OUT(q);
  const o = Math.min(Math.max(overshoot, 0), MOVE.overshootMax);
  if (o === 0) return base;
  return base + o * Math.sin(Math.PI * clamp01((q - 0.5) / 0.5));
}

/**
 * Use when a list arrives or reacts to a touch: items start in order of their distance from the cause, so
 * it ripples out from the finger. Returns item i's own time in ms (negative before it starts); feed it
 * to seg() or a move. `gap` defaults to MOVE.staggerMs (60 ms).
 */
export function staggerFrom(i: number, positions: readonly Pt[], causeIndex: number, ms: number, start: number, gap: number = MOVE.staggerMs): number {
  'worklet';
  const c = positions[causeIndex];
  const di = Math.hypot(positions[i].x - c.x, positions[i].y - c.y);
  let rank = 0;
  for (let j = 0; j < positions.length; j++) {
    const dj = Math.hypot(positions[j].x - c.x, positions[j].y - c.y);
    if (dj < di || (dj === di && j < i)) rank++;
  }
  return ms - start - rank * gap;
}

/**
 * Use when something appears: linear p over MOVE.entrance (380 ms), eased inside. Scale from MOVE.enterScale, travel up from
 * `travel` pt below, and opacity finished within the first MOVE.fadeMax (250 ms). Opacity is never the
 * whole move: the scale and travel carry the rest.
 */
export function enter(p: number, travel = 12): { scale: number; opacity: number; y: number } {
  'worklet';
  const q = clamp01(p);
  const e = EASE_OUT(q);
  const fadeShare = MOVE.fadeMax / MOVE.entrance;
  return { scale: lerp(MOVE.enterScale, 1, e), opacity: EASE_OUT(clamp01(q / fadeShare)), y: travel * (1 - e) };
}

/**
 * Use when something leaves: linear p over MOVE.exitMs (266 ms = 0.7 of an entrance). Scale to MOVE.enterScale,
 * travel `travel` pt down, opacity gone within MOVE.fadeMax. Leave toward where it goes (carry) when it
 * goes somewhere; this is for what simply ends.
 */
export function exit(p: number, travel = 8): { scale: number; opacity: number; y: number } {
  'worklet';
  const q = clamp01(p);
  const e = EASE_IN(q);
  const fadeShare = MOVE.fadeMax / MOVE.exitMs;
  return { scale: lerp(1, MOVE.enterScale, e), opacity: 1 - EASE_IN_OUT(clamp01(q / fadeShare)), y: travel * e };
}

/**
 * Use when an item is collected into a counter, a slot or a bag: it flies from `from` to `to` along an
 * arc (0.15 of the distance) and shrinks to 0.7. Over MOVE.handover. Pair with contact() on the target.
 */
export function flyInto(from: Pt, to: Pt, p: number): { x: number; y: number; scale: number } {
  'worklet';
  const e = CUBIC_IN_OUT(p);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const bow = d > 0 ? 0.15 * d * Math.sin(Math.PI * e) : 0;
  return { x: lerp(from.x, to.x, e) - (d > 0 ? (dy / d) * bow : 0), y: lerp(from.y, to.y, e) + (d > 0 ? (dx / d) * bow : 0), scale: lerp(1, 0.7, e) };
}

/**
 * The target's reply when something lands on it: ms since the arrival. Squashes MOVE.contactSquash (6 %)
 * across and recovers within MOVE.contactMs (200 ms), volume kept (sx = keepVolume(sy)). Returns the
 * target's scale; 1, 1 outside the window.
 */
export function contact(msSinceArrival: number): { sx: number; sy: number } {
  'worklet';
  if (msSinceArrival <= 0 || msSinceArrival >= MOVE.contactMs) return { sx: 1, sy: 1 };
  const q = msSinceArrival / MOVE.contactMs;
  const bump = q < 0.25 ? EASE_OUT(q / 0.25) : 1 - EASE_IN_OUT((q - 0.25) / 0.75);
  const sy = 1 - MOVE.contactSquash * bump;
  return { sx: keepVolume(sy), sy };
}

/**
 * Use when a number changes: an odometer. `value` eases from `from` to `to` over MOVE.handover; `digits[k]`
 * is the digit at place k (0 = ones) and `offsets[k]` (0..1) how far that place is rolling toward its
 * next digit, so the rightmost place is the fastest. Draw each place as a strip shifted by its offset.
 */
export function roll(from: number, to: number, p: number): { value: number; digits: number[]; offsets: number[] } {
  'worklet';
  const value = lerp(from, to, CUBIC_IN_OUT(p));
  const top = Math.max(Math.abs(from), Math.abs(to));
  const places = Math.max(1, String(Math.floor(top)).length);
  const digits: number[] = [];
  const offsets: number[] = [];
  const v = Math.abs(value);
  for (let k = 0; k < places; k++) {
    const unit = Math.pow(10, k);
    digits.push(Math.floor(v / unit) % 10);
    const f = (v / unit) % 1;
    offsets.push(k === 0 ? f : clamp01((f - 0.9) / 0.1));
  }
  return { value, digits, offsets };
}

/**
 * Use when a tap opens something: a circle from the tap point grows until it covers the box's farthest
 * corner. Returns the circle (centre and radius); clip or fill the box with it. Over MOVE.handover.
 */
export function revealRadius(origin: Pt, box: Box, p: number): { cx: number; cy: number; r: number } {
  'worklet';
  let far = 0;
  for (let i = 0; i < 4; i++) {
    const cx = box.x + (i % 2 ? box.w : 0);
    const cy = box.y + (i > 1 ? box.h : 0);
    far = Math.max(far, Math.hypot(cx - origin.x, cy - origin.y));
  }
  return { cx: origin.x, cy: origin.y, r: far * EASE_OUT(clamp01(p)) };
}
