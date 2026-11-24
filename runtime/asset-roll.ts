/**
 * A rolling number: the odometer a text node with `roll` draws. Pure and worklet-safe (no regular expressions, no Intl), so the app's
 * draw worklet, the SVG preview and `skac asset check` share one answer.
 */

/** The zero of each decimal digit system a roll accepts: Latin, Arabic-Indic, Extended Arabic-Indic (Urdu, Persian), Devanagari, Bengali,
 * Gurmukhi, Gujarati, Tamil, Thai, Myanmar, fullwidth. A value in any of them rolls in its own glyphs. */
export const DIGIT_ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xbe6, 0xe50, 0x1040, 0xff10] as const;

export type RollNumber = { prefix: string; digits: number[]; suffix: string; zero: number };
/** One digit place, left to right. `current` and `next` are 0 to 9, or -1 for a blank leading place. `turn` is how far the column has
 * moved from current to next, 0 to 1. */
export type RollPlace = { current: number; next: number; turn: number };
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

/**
 * The odometer between two values at progress 0 to 1. The shown value runs linearly from `from` to `to`; place i turns during the last
 * unit of the places to its right, so the rightmost place turns fastest and a place moves only when the one below it wraps. The number of
 * places is the longer of the two, and a leading place is blank until the value reaches it, so the width never changes. Prefix, suffix and
 * digit system come from `to`. Undefined when either value is not one run of digits, or they differ in prefix, suffix or digit system:
 * the caller shows `from` before 0.5 and `to` after.
 */
export function rollFrame(from: string, to: string, progress: number): RollFrame | undefined {
  'worklet';
  const a = parseRoll(from);
  const b = parseRoll(to);
  if (!a || !b || a.prefix !== b.prefix || a.suffix !== b.suffix || a.zero !== b.zero) return undefined;
  const p = Math.min(1, Math.max(0, progress));
  const start = valueOf(a.digits);
  const end = valueOf(b.digits);
  const count = Math.max(a.digits.length, b.digits.length);
  const value = start + (end - start) * p;
  const places: RollPlace[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const unit = 10 ** i;
    const base = Math.floor(value / unit + 1e-9);
    const below = value - base * unit;
    const turn = Math.min(1, Math.max(0, below - (unit - 1)));
    const current = base === 0 && i > 0 ? -1 : base % 10;
    const next = (base + 1) % 10;
    places.push({ current, next, turn: turn < 1e-6 ? 0 : turn });
  }
  return { prefix: b.prefix, suffix: b.suffix, zero: b.zero, places };
}

/** The character for a digit 0 to 9 in a digit system, or '' for a blank place. */
export function digitText(digit: number, zero: number): string {
  'worklet';
  return digit < 0 ? '' : String.fromCodePoint(zero + digit);
}
