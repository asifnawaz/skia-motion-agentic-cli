/**
 * A rolling number: the odometer a text node with `roll` draws. Pure and worklet-safe (no regular expressions, no Intl), so the app's
 * draw worklet, the SVG preview and `skac asset check` share one answer.
 */

import { DIGIT_ZEROS } from './asset-unicode';

/** A value in any decimal digit system (asset-unicode.ts lists their zeros) rolls in its own glyphs. */
export { DIGIT_ZEROS };

export type RollNumber = { prefix: string; digits: number[]; suffix: string; zero: number };
/** One digit place, left to right. `current` and `next` are 0 to 9, or -1 for a blank leading place. `turn` is how far the column has
 * moved from current to next, 0 to 1. `smear` is 0 while the place turns slowly enough to read, rising to 1 as it passes
 * SMEAR_FULL turns a second: the app draws it as a vertical blur of its column then. */
export type RollPlace = { current: number; next: number; turn: number; smear: number };
/** How the shown value runs over the roll: 'out' (the default) slows into the new value so its last turns read; 'linear' runs evenly. */
export type RollEase = 'out' | 'linear';
/** A text's roll settings: the ease, and `ms`, the time the progress channel takes from 0 to 1 (rollSpan), when known. */
export type RollTiming = { ease?: RollEase; ms?: number };
/** A place turning faster than this many times a second cannot be read; it starts to smear here and is fully smeared at SMEAR_FULL. */
export const SMEAR_FROM = 30;
export const SMEAR_FULL = 60;
/** A fully smeared place blurs down its column by this share of the line height (the blur's sigma). */
export const SMEAR_SIGMA = 0.2;
export type RollFrame = { prefix: string; suffix: string; zero: number; places: RollPlace[] };

function digitOf(code: number): { zero: number; value: number } | undefined {
  'worklet';
  for (const zero of DIGIT_ZEROS) if (code >= zero && code < zero + 10) return { zero, value: code - zero };
  return undefined;
}

/** Split "+1250 XP" into a prefix, one run of digits and a suffix. Undefined when the digits are not one run, mix systems or are absent. */
export function parseRoll(text: string): RollNumber | undefined {
  'worklet';
  const codes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    codes.push(code);
    if (code > 0xffff) i++;
  }
  let start = -1;
  let end = -1;
  let zero = -1;
  const digits: number[] = [];
  for (let i = 0; i < codes.length; i++) {
    const digit = digitOf(codes[i]!);
    if (!digit) continue;
    if (end >= 0 && end !== i) return undefined; // a second run: "1,250" or "3 of 5"
    if (zero >= 0 && digit.zero !== zero) return undefined;
    if (start < 0) start = i;
    end = i + 1;
    zero = digit.zero;
    digits.push(digit.value);
  }
  if (start < 0) return undefined;
  const join = (list: number[]) => {
    let out = '';
    for (const code of list) out += String.fromCodePoint(code);
    return out;
  };
  return { prefix: join(codes.slice(0, start)), digits, suffix: join(codes.slice(end)), zero };
}

const valueOf = (digits: readonly number[]) => {
  'worklet';
  let value = 0;
  for (const digit of digits) value = value * 10 + digit;
  return value;
};

const easeValue = (progress: number, ease: RollEase) => {
  'worklet';
  return ease === 'linear' ? progress : 1 - (1 - progress) ** 3;
};

const easeSlope = (progress: number, ease: RollEase) => {
  'worklet';
  return ease === 'linear' ? 1 : 3 * (1 - progress) ** 2;
};

type ClipKeys = Readonly<Record<string, { tracks: Readonly<Record<string, readonly (readonly [number, number, ...unknown[]])[]>> }>>;

/**
 * How long a roll's progress channel takes to run from 0 to 1, in ms: in each clip that keys it, the time from its last still key to the
 * first key at its final value, over the change. The fastest clip wins; undefined when no clip moves the channel.
 */
export function rollSpan(clips: ClipKeys, channel: string): number | undefined {
  let fastest: number | undefined;
  for (const { tracks } of Object.values(clips)) {
    const keys = tracks[channel];
    if (!keys || keys.length < 2) continue;
    const first = keys[0]![1];
    const last = keys[keys.length - 1]![1];
    if (first === last) continue;
    let from = keys[0]![0];
    for (let i = 1; i < keys.length; i++) if (keys[i]![1] !== first) { from = keys[i - 1]![0]; break; }
    let to = keys[keys.length - 1]![0];
    for (let i = keys.length - 1; i > 0; i--) if (keys[i - 1]![1] !== last) { to = keys[i]![0]; break; }
    const ms = (to - from) / Math.abs(last - first);
    if (ms > 0) fastest = fastest === undefined ? ms : Math.min(fastest, ms);
  }
  return fastest;
}

/**
 * The odometer between two values at progress 0 to 1. The shown value runs from `from` to `to` by the roll's ease; place i turns during the last
 * unit of the places to its right, so the rightmost place turns fastest and a place moves only when the one below it wraps. The number of
 * places is the longer of the two; a leading place is blank until the value reaches it, and opens as its first digit rolls in. Prefix, suffix and
 * digit system come from `to`. Undefined when either value is not one run of digits, or they differ in prefix, suffix or digit system:
 * the caller shows `from` before 0.5 and `to` after.
 */
export function rollFrame(from: string, to: string, progress: number, timing: RollTiming = {}): RollFrame | undefined {
  'worklet';
  const a = parseRoll(from);
  const b = parseRoll(to);
  if (!a || !b || a.prefix !== b.prefix || a.suffix !== b.suffix || a.zero !== b.zero) return undefined;
  const p = Math.min(1, Math.max(0, progress));
  const start = valueOf(a.digits);
  const end = valueOf(b.digits);
  const count = Math.max(a.digits.length, b.digits.length);
  // A zero-padded string ("000120") writes its padding zeros, so those places are never blank; otherwise a leading place is blank until
  // the value reaches it.
  const padded = (digits: readonly number[]) => (digits.length > 1 && digits[0] === 0 ? digits.length : 0);
  const written = p < 0.5 ? padded(a.digits) : padded(b.digits);
  const ease = timing.ease ?? 'out';
  const value = start + (end - start) * easeValue(p, ease);
  // Place i turns once per 10^i of value, so its turns a second are the value's speed over 10^i. Before the roll starts and once it
  // has ended nothing turns, so nothing smears there, whatever the ease's slope at the ends.
  const speed = timing.ms && p > 0 && p < 1 ? Math.abs(end - start) * easeSlope(p, ease) * 1000 / timing.ms : 0;
  const places: RollPlace[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const unit = 10 ** i;
    const base = Math.floor(value / unit + 1e-9);
    const below = value - base * unit;
    const turn = Math.min(1, Math.max(0, below - (unit - 1)));
    const current = base === 0 && i > 0 && i >= written ? -1 : base % 10;
    const next = (base + 1) % 10;
    const smear = Math.min(1, Math.max(0, (speed / unit - SMEAR_FROM) / (SMEAR_FULL - SMEAR_FROM)));
    places.push({ current, next, turn: turn < 1e-6 ? 0 : turn, smear });
  }
  return { prefix: b.prefix, suffix: b.suffix, zero: b.zero, places };
}

/** The character for a digit 0 to 9 in a digit system, or '' for a blank place. */
export function digitText(digit: number, zero: number): string {
  'worklet';
  return digit < 0 ? '' : String.fromCodePoint(zero + digit);
}

// Worklets capture a helper when the function using it is defined, so helpers come first.
type Feature = { name: string; value: number };

/**
 * A rolling text's style: its own, with tabular figures on, so every digit takes one advance. The app draws it this way and asset check
 * measures it this way; any other node comes back unchanged.
 */
export function rollTextStyle<N extends { roll?: unknown; fontFeatures?: readonly Feature[] }>(node: N): N {
  'worklet';
  if (!node.roll || node.fontFeatures?.some(({ name }) => name === 'tnum')) return node;
  return { ...node, fontFeatures: [...(node.fontFeatures ?? []), { name: 'tnum', value: 1 }] };
}

/**
 * How far a rolling number's width has gone from its old value's to its new one's, 0 to 1: the share a row moves it by, so the gap to
 * an icon holds while places open. When the two have as many places, the eased progress (the value's own share).
 */
export function rollWidthShare(from: string, to: string, progress: number, timing: RollTiming = {}): number {
  'worklet';
  const p = Math.min(1, Math.max(0, progress));
  const frame = rollFrame(from, to, p, timing);
  if (!frame) return p < 0.5 ? 0 : 1;
  const width = (f: RollFrame) => {
    let places = 0;
    let opening = 0;
    for (const { current, turn } of f.places) {
      if (current >= 0) places++;
      else opening = Math.max(opening, turn);
    }
    return places + opening;
  };
  const start = width(rollFrame(from, to, 0, timing)!);
  const end = width(rollFrame(from, to, 1, timing)!);
  if (start === end) return easeValue(p, timing.ease ?? 'out');
  return Math.min(1, Math.max(0, (width(frame) - start) / (end - start)));
}

/** The text a frame shows at rest: prefix, the digits of the places that are not blank, suffix. */
export function restText(frame: RollFrame): string {
  'worklet';
  let digits = '';
  for (const { current } of frame.places) digits += digitText(current, frame.zero);
  return frame.prefix + digits + frame.suffix;
}

