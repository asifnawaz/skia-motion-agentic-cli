// face.ts: the face as pure math, no React or Skia, so a rig file, a test or skac's checks can import it
// in plain Node. liveFace.tsx draws it. Adapted from rossark-motion-skill (MIT) and huashu-art-motion (MIT);
// see NOTICE.md and `skac docs motion/faces`. Every function here is a worklet in the app.
import { flow, track, type FlowKeys, type Key, type Keys } from './motion';

/**
 * One character's face choreography. Missing channels rest at their default.
 * lookX / lookY: eye offset in pt (flow).            lid: upper lid 0 open .. 1 shut (track: one move).
 * cheek: lower lid rising, 0..1; above 0.86 the happy arc shows (delight).
 * squeeze: wind-up scrunch, 0..1, read with lid = 1; turns the closed line into a tight chevron.
 * wide: shock, 0..1, eyes 1.0x -> 1.25x.            smile: 0..1 rest smile (default 1).
 * grin: open grin, 0..1.                             o: surprised O mouth, 0..1.
 */
export type FaceChoreo = {
  lookX?: FlowKeys;
  lookY?: FlowKeys;
  lid?: Keys;
  cheek?: FlowKeys;
  squeeze?: FlowKeys;
  wide?: FlowKeys;
  grin?: FlowKeys;
  o?: FlowKeys;
};

export type FaceState = { lookX: number; lookY: number; lid: number; cheek: number; squeeze: number; wide: number; grin: number; o: number };

const clamp01 = (x: number) => {
  'worklet';
  return Math.min(1, Math.max(0, x));
};

/** Every face channel at time t (ms). */
export function faceAt(t: number, c: FaceChoreo): FaceState {
  'worklet';
  return {
    lookX: c.lookX ? flow(t, c.lookX) : 0,
    lookY: c.lookY ? flow(t, c.lookY) : 0,
    lid: c.lid ? clamp01(track(t, c.lid)) : 0,
    cheek: c.cheek ? clamp01(flow(t, c.cheek)) : 0,
    squeeze: c.squeeze ? clamp01(flow(t, c.squeeze)) : 0,
    wide: c.wide ? clamp01(flow(t, c.wide)) : 0,
    grin: c.grin ? clamp01(flow(t, c.grin)) : 0,
    o: c.o ? clamp01(flow(t, c.o)) : 0,
  };
}

/**
 * Blink keys: close 110 ms, hold 40 ms, reopen 190 ms with 'out' (reopening is slower than closing).
 * Never shorter: a 70 ms close is two frames at 30 fps and flickers (rossark §4, §1.12).
 */
export function blinkKeys(starts: readonly number[], end: number): Key[] {
  const k: Key[] = [[0, 0]];
  for (const s of starts) k.push([s, 0], [s + 110, 1], [s + 150, 1], [s + 340, 0, 'out']);
  k.push([end, 0]);
  return k;
}

/** Where one solid eye sits at rest (for example 14 x 20 pt black ovals, 44 pt apart). */
export type SolidEye = { cx: number; cy: number; w: number; h: number; shine: number };
export type FaceInk = { eye: string; shine: string; skin: string; mouth: string; tongue: string; line: number };

/** The eye's drawing at this instant: all strings and numbers, safe to derive on the UI thread. */
export function eyeGeometry(e: SolidEye, f: FaceState, side: -1 | 1) {
  'worklet';
  const s = 1 + 0.25 * f.wide; // shock widens the eye to 1.25x (huashu toon.js shock 1.28)
  const w = e.w * s;
  const h = e.h * s;
  const cx = e.cx + f.lookX;
  const cy = e.cy + f.lookY;
  const top = 0.85 * f.lid * (h + 2); // the upper lid travels 85 %...
  const bottom = Math.min(1, 0.15 * f.lid + f.cheek) * (h + 2); // ...the lower lid rises 15 % to meet it (rossark §4)
  const closed = clamp01((f.lid - 0.88) / 0.12);
  const happy = clamp01((f.cheek - 0.86) / 0.14);
  return {
    eye: { x: cx - w / 2, y: cy - h / 2, w, h },
    // the skin lids are clipped to a shape 1 pt larger all round than the eye: clipped to the exact
    // eye, the anti-aliased edge leaks around a closed eye and reads as glasses (rossark §4, §8)
    clip: { x: cx - w / 2 - 1, y: cy - h / 2 - 1, w: w + 2, h: h + 2 },
    lidPath: `M${cx - w} ${cy - h / 2 - 1}h${2 * w}v${top}h${-2 * w}Z`,
    cheekPath: `M${cx - w} ${cy + h / 2 + 1}h${2 * w}v${-bottom}h${-2 * w}Z`,
    shine: { cx: cx + w * 0.2, cy: cy - h * 0.24, r: e.shine * (1 - 0.3 * f.wide), opacity: 1 - closed },
    // a soft closed line, a tight wind-up chevron pointing at the nose, a happy arc
    closedPath: `M${cx - 7} ${cy + 1}Q${cx} ${cy + 5} ${cx + 7} ${cy + 1}`,
    closedOpacity: closed * (1 - f.squeeze),
    squeezePath: `M${cx - side * 7} ${cy - 5}L${cx + side * 5} ${cy + 1}L${cx - side * 7} ${cy + 6}`,
    squeezeOpacity: closed * f.squeeze,
    happyPath: `M${cx - 7} ${cy + 3}Q${cx + side * 0.5} ${cy - 8} ${cx + 7} ${cy + 3}`,
    happyOpacity: happy,
  };
}

/**
 * The ONE mouth path. Two cubic halves between the corners: the top half's handles sit `top`
 * below the corner line, the bottom half's `bot` below it, at `hx` of the half width.
 *   rest smile: w 22, top 6,   bot 6   (zero area; the 3 pt stroke reads as the spec's arc, 4.5 pt deep)
 *   grin:       w 26, top 3,   bot 20  (open D, tongue shows)
 *   O:          w 14, top -12, bot 12, hx 1 (an upright oval 14 x 18 pt: never smaller, see `skac docs motion/faces`)
 * Channels blend these linearly, so the mouth morphs; it never swaps (huashu toon.js mouth set).
 */
export function mouthGeometry(cx: number, y: number, f: FaceState) {
  'worklet';
  const g = f.grin * (1 - f.o);
  const o = f.o;
  const r = 1 - g - o;
  const w = 22 * r + 26 * g + 14 * o;
  const top = 6 * r + 3 * g - 12 * o;
  const bot = 6 * r + 20 * g + 12 * o;
  const hx = 0.5 * (1 - o) + 1 * o;
  const yc = y + 4 * o; // the O sits a little lower, centred where the smile's dip was
  const a = (w / 2) * hx;
  const path = `M${cx - w / 2} ${yc}C${cx - a} ${yc + top} ${cx + a} ${yc + top} ${cx + w / 2} ${yc}C${cx + a} ${yc + bot} ${cx - a} ${yc + bot} ${cx - w / 2} ${yc}Z`;
  const open = Math.max(0, bot - Math.max(top, 0)) * 0.75; // visible depth of the opening
  return {
    path,
    tongue: { x: cx - w * 0.28, y: yc + bot * 0.75 - open * 0.45, w: w * 0.56, h: open * 0.6, opacity: clamp01(open / 6) },
  };
}
