// paths.ts: Skia path moves as pure worklets: morph one outline into another, draw a stroke on, sample a
// path as points for points.ts. Skia 2.14 paths are immutable, so nothing here changes its input.
// Imports Skia and './motion' only; every exported function is a worklet.
// With Skia.Font and Skia.Path.MakeFromText(text, x, y, font) a word becomes a path, then points for
// morphPoints: for a word drawn on the canvas in a video (Urdu or Arabic stay native text in the app).
import { Skia, type SkPath } from '@shopify/react-native-skia';

const clamp01 = (x: number) => {
  'worklet';
  return Math.min(1, Math.max(0, x));
};

/**
 * True when two paths have the same verbs and weights, so morphPath can blend them. Use it to choose
 * between a path morph and morphPoints in a rig. Draw both shapes from the same command list to make it true.
 */
export function morphable(a: SkPath, b: SkPath): boolean {
  'worklet';
  return a.isInterpolatable(b);
}

/**
 * Use when one outline becomes another: an icon into another icon, a plate into a pill. p 0 is `a`,
 * p 1 is `b`. Throws when the paths do not share their verbs, so a render and `--check` fail loudly.
 * (Skia's `b.interpolate(a, w)` gives `a` at weight 0 and `b` at weight 1.)
 */
export function morphPath(a: SkPath, b: SkPath, p: number): SkPath {
  'worklet';
  if (!a.isInterpolatable(b)) throw new Error('morphPath: the two paths do not share their verbs (draw both from the same command list, or use morphPoints)');
  const out = b.interpolate(a, clamp01(p));
  if (!out) throw new Error('morphPath: the two paths do not share their verbs (draw both from the same command list, or use morphPoints)');
  return out;
}

/**
 * Use when a stroke draws itself: a check completing, a line underlining, a ring closing. Returns the
 * path from its start to fraction p (0 gives an empty path, 1 gives the whole path). Stroke it with
 * round caps. The input is not changed: Skia.Path.Trim returns a new path.
 */
export function drawOn(path: SkPath, p: number): SkPath {
  'worklet';
  const q = clamp01(p);
  if (q >= 1) return path;
  if (q <= 0) return Skia.Path.Make();
  return Skia.Path.Trim(path, 0, q, false) ?? Skia.Path.Make();
}

/**
 * `n` points spaced evenly along the path's outline, as [x, y] pairs (all contours, by length). Feed them
 * to morphPoints or arrive. Run once outside the render loop: it walks the whole path.
 */
export function pathPoints(path: SkPath, n: number): [number, number][] {
  'worklet';
  const iter = Skia.ContourMeasureIter(path, false, 1);
  const contours = [];
  let total = 0;
  for (let c = iter.next(); c; c = iter.next()) {
    contours.push(c);
    total += c.length();
  }
  const out: [number, number][] = [];
  if (total <= 0 || n <= 0) return out;
  let ci = 0;
  let before = 0;
  for (let i = 0; i < n; i++) {
    const d = (total * i) / n;
    while (ci < contours.length - 1 && d >= before + contours[ci].length()) {
      before += contours[ci].length();
      ci++;
    }
    const pos = contours[ci].getPosTan(d - before)[0];
    out.push([pos.x, pos.y]);
  }
  return out;
}

/**
 * A grid of points every `pitch` units inside the path's fill (row by row), as [x, y] pairs, for a word
 * or shape drawn as a point cloud. Run once outside the render loop.
 */
export function fillPoints(path: SkPath, pitch: number): [number, number][] {
  'worklet';
  const b = path.getBounds();
  const out: [number, number][] = [];
  if (pitch <= 0) return out;
  for (let y = b.y + pitch / 2; y < b.y + b.height; y += pitch) {
    for (let x = b.x + pitch / 2; x < b.x + b.width; x += pitch) {
      if (path.contains(x, y)) out.push([x, y]);
    }
  }
  return out;
}
