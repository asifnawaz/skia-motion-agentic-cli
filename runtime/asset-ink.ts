/**
 * Ink and optical centres, and the `row` layout built on them. Pure and worklet-safe (no regular expressions), so the app's draw worklet,
 * the SVG preview and `skac asset check` place a row from one rule: what the check passes is what the phone draws.
 */
import { CASELESS_LETTERS, DIGIT_ZEROS, LOWERCASE_LETTERS, UPPERCASE_LETTERS } from './asset-unicode';

/** left, top, right, bottom */
export type Box = readonly [number, number, number, number];
/** A text's ink box and the optical band its centre is taken from, in its paragraph's units. */
export type TextInk = { box: Box; band: readonly [number, number] };
/** One laid-out child of a row: its ink box in the row's units before it is moved, and the height its centre sits at. */
export type RowItem = { box: Box; centre: number };
export type RowAlign = 'start' | 'center' | 'end';

/** Whether a code point is in a flat, ascending [first, last, ...] range table. */
function inRanges(code: number, ranges: readonly number[]): boolean {
  'worklet';
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (code < ranges[mid * 2]!) high = mid - 1;
    else if (code > ranges[mid * 2 + 1]!) low = mid + 1;
    else return true;
  }
  return false;
}

function isDigit(code: number): boolean {
  'worklet';
  for (const zero of DIGIT_ZEROS) if (code >= zero && code < zero + 10) return true;
  return false;
}

/**
 * How a text reads for its optical centre: 'lower' when it has lowercase letters and no capitals or digits, 'caseless' when it has
 * letters with no case, as in Arabic or Devanagari (centred on the ink), else 'cased'. A cased or lower text is centred on a band from
 * its x-height to its cap height by `capShare`.
 */
export function textCase(text: string): 'lower' | 'caseless' | 'cased' {
  'worklet';
  let lower = false;
  let upperOrDigit = false;
  let caseless = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (code > 0xffff) i++;
    if (isDigit(code) || inRanges(code, UPPERCASE_LETTERS)) upperOrDigit = true;
    else if (inRanges(code, LOWERCASE_LETTERS)) lower = true;
    else if (inRanges(code, CASELESS_LETTERS)) caseless = true;
  }
  if (lower && !upperOrDigit) return 'lower';
  return caseless ? 'caseless' : 'cased';
}

/**
 * How much of a cased text stands at the cap height: its capitals and digits as a share of its capitals, digits and lowercase letters.
 * 1 with no lowercase ("+3", "XP"), 0 with lowercase only ("correct"), and between for a mixed label: "5 of 5 correct" is 2 of 11.
 */
export function capShare(text: string): number {
  'worklet';
  let high = 0;
  let low = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (code > 0xffff) i++;
    if (isDigit(code) || inRanges(code, UPPERCASE_LETTERS)) high++;
    else if (inRanges(code, LOWERCASE_LETTERS)) low++;
  }
  return low === 0 ? 1 : high / (high + low);
}

/**
 * A text's ink from its glyphs' boxes (each already at its place in the paragraph), and its band, from the first run's face: from the
 * first baseline down to the last, and up from the first baseline by the x-height plus `capShare` of the step to the cap height. So
 * "+3" stands on its cap height, "correct" on its x-height, and a mixed label such as "5 of 5 correct" mostly on its x-height, where most
 * of its letters are; centring it by its two digits left the lowercase 1.5 pt low (O-8590). Undefined when no glyph draws.
 */
export function textInk(
  glyphs: readonly Box[], firstBaseline: number, lastBaseline: number, text: string, heights: { cap: number; x: number },
): TextInk | undefined {
  'worklet';
  let box: Box | undefined;
  for (const [l, t, r, b] of glyphs) {
    if (!(r > l && b > t)) continue; // a space draws nothing
    box = box ? [Math.min(box[0], l), Math.min(box[1], t), Math.max(box[2], r), Math.max(box[3], b)] : [l, t, r, b];
  }
  if (!box) return undefined;
  if (textCase(text) === 'caseless') return { box, band: [box[1], box[3]] };
  const share = capShare(text);
  // A face that gives only one of the two heights stands on that one; a text of capitals with no cap height is judged by its ink.
  const low = heights.x || heights.cap;
  const high = heights.cap || (share < 1 ? heights.x : 0);
  const height = low && high ? low + share * (high - low) : 0;
  const band: [number, number] = height ? [firstBaseline - height, lastBaseline] : [box[1], box[3]];
  return { box, band };
}

/** Part way from one ink to another: a rolling count in a row is placed between its old value's ink and its new one's as it rolls. */
export function blendInk(from: TextInk | undefined, to: TextInk | undefined, progress: number): TextInk | undefined {
  'worklet';
  if (!from || !to) return progress < 0.5 ? from : to;
  const t = Math.min(1, Math.max(0, progress));
  const mix = (a: number, b: number) => a + (b - a) * t;
  return {
    box: [mix(from.box[0], to.box[0]), mix(from.box[1], to.box[1]), mix(from.box[2], to.box[2]), mix(from.box[3], to.box[3])],
    band: [mix(from.band[0], to.band[0]), mix(from.band[1], to.band[1])],
  };
}

/**
 * Place a row: each item moves across so its ink starts `gap` after the ink before it (right to left, the first item is on the right),
 * and down so its optical centre is at 0. `align` puts the row's ink start, centre or end at 0. Returns each item's move and the
 * row's ink box after the moves.
 */
export function rowLayout(items: readonly RowItem[], gap: number, align: RowAlign = 'start', rtl = false): { moves: [number, number][]; box: Box } {
  'worklet';
  const order = items.map((_, i) => i);
  if (rtl) order.reverse();
  const moves: [number, number][] = items.map(() => [0, 0]);
  let cursor = 0;
  let top = Infinity;
  let bottom = -Infinity;
  for (const i of order) {
    const { box, centre } = items[i]!;
    moves[i] = [cursor - box[0], -centre];
    cursor += box[2] - box[0] + gap;
    top = Math.min(top, box[1] - centre);
    bottom = Math.max(bottom, box[3] - centre);
  }
  const width = items.length ? cursor - gap : 0;
  const shift = align === 'center' ? -width / 2 : align === 'end' ? -width : 0;
  for (const move of moves) move[0] += shift;
  return { moves, box: items.length ? [shift, top, shift + width, bottom] : [0, 0, 0, 0] };
}

/**
 * A row's plate: around the row laid out with `widest` items (the bound texts showing their widest sample), so its width never changes
 * with the value, and as tall as the tallest band or box above and below 0 plus the padding, so it never changes with descenders either.
 */
export function plateBox(widest: readonly RowItem[], bands: readonly [number, number][], gap: number, align: RowAlign, rtl: boolean, padding: readonly [number, number]): Box {
  'worklet';
  const { box } = rowLayout(widest, gap, align, rtl);
  let half = 0;
  for (const [top, bottom] of bands) half = Math.max(half, -top, bottom);
  return [box[0] - padding[0], -half - padding[1], box[2] + padding[0], half + padding[1]];
}

type Scalar = number | string;
/** The children a row places: texts, images and simple shapes. */
export type RowChild =
  | { kind: 'text'; x: Scalar; y: Scalar; text: string | { value: string } }
  | { kind: 'image'; image: string; x: Scalar; y: Scalar; width: Scalar; height: Scalar }
  | { kind: 'ellipse' | 'roundRect'; x: Scalar; y: Scalar; width: Scalar; height: Scalar };

/**
 * A row's items, measured by the caller's own engine (Skia on the phone, CanvasKit in check) through one rule: a text by its ink and
 * optical band (`ink`, in its paragraph's units), an image by its ink box (`imagePart`, fractions of its box; the whole box when
 * unknown, as for a host image slot), a shape by its box. `widest` gives the same items with every bound text showing the plate's widest
 * sample.
 */
export function rowItems(
  children: readonly RowChild[], read: (value: Scalar | undefined, fallback?: number) => number,
  ink: (child: RowChild & { kind: 'text' }, index: number, widest: boolean) => TextInk | undefined,
  imagePart: (index: number) => Box | undefined, hasWidest: boolean,
): { items: RowItem[]; widest: RowItem[]; bands: [number, number][] } {
  'worklet';
  const items: RowItem[] = [];
  const widest: RowItem[] = [];
  const bands: [number, number][] = [];
  children.forEach((child, index) => {
    const x = read(child.x);
    const y = read(child.y);
    if (child.kind === 'text') {
      const shown = ink(child, index, false);
      const wide = hasWidest && typeof child.text !== 'string' ? ink(child, index, true) : undefined;
      // A bound text's band comes from the widest sample when there is one, so a script centred on its ink (no cap height) neither bobs
      // nor resizes the plate as the value changes; for capitals and digits the band is the same either way.
      const band = (wide ?? shown)?.band;
      const place = (measured: TextInk | undefined): RowItem => (measured && band
        ? { box: [x + measured.box[0], y + measured.box[1], x + measured.box[2], y + measured.box[3]], centre: y + (band[0] + band[1]) / 2 }
        : { box: [x, y, x, y], centre: y });
      const item = place(shown);
      items.push(item);
      if (band) bands.push([y + band[0] - item.centre, y + band[1] - item.centre]);
      widest.push(wide ? place(wide) : item);
      return;
    }
    const w = read(child.width);
    const h = read(child.height);
    const part = child.kind === 'image' ? imagePart(index) : undefined;
    const box: Box = part ? [x + part[0] * w, y + part[1] * h, x + part[2] * w, y + part[3] * h] : [x, y, x + w, y + h];
    const item = { box, centre: (box[1] + box[3]) / 2 };
    items.push(item);
    widest.push(item);
    bands.push([box[1] - item.centre, box[3] - item.centre]);
  });
  return { items, widest, bands };
}
