// Interface.draw.ts: the drawing of Interface, imperative Skia, one function of the rig's channels.
// The video (Interface.tsx) and the app (`skac Interface --export <dir>`) both call it, so it imports no React,
// Remotion or Reanimated. In an app the title and the words are native text; here they are drawn stand-ins.
import { ClipOp, Skia, type SkCanvas, type SkPaint } from '@shopify/react-native-skia';
import { drawOn, pathPoints } from './motion/paths';
import { morphPoints, sortPoints } from './motion/points';
import { roll } from './motion/moves';
import { COUNT, DETAIL_CARD, LIST_CARD, LIST_ROWS, SHEET, TITLE, type Channels } from './Interface.rig';

const COLOR = { bg: '#1E2A44', seal: '#F6C453', ring: '#2B2118', title: '#EDE6D6', card: '#F6C453', row: '#2C3B5E', sheet: '#EDE6D6', button: '#F6C453', check: '#3E8A57', ink: '#2B2118' };

// The check mark and the two point shapes (a word's squiggle, the numeral 3), in pt inside the sheet.
const CHECK = 'M168 612L190 634L228 590';
const WORD = 'M140 760C158 728 172 792 192 760S232 728 252 760';
const NUMERAL = 'M168 724C222 712 230 754 192 762C234 770 226 812 168 800';
const POINTS = 90;

// A digit drawn as strokes (seven segments), so the roll needs no font. Origin top-left, 18 x 32 pt.
const SEGMENTS: Record<string, string> = {
  a: 'M2 2H16', b: 'M16 2V16', c: 'M16 16V30', d: 'M2 30H16', e: 'M2 16V30', f: 'M2 2V16', g: 'M2 16H16',
};
const DIGITS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'];
const DIGIT_H = 32;
const PLACE_W = 26;

const fill = (hex: string, alpha = 1): SkPaint => {
  'worklet';
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setColor(Skia.Color(hex));
  p.setAlphaf(alpha);
  return p;
};

const stroke = (hex: string, width: number, alpha = 1): SkPaint => {
  'worklet';
  const p = fill(hex, alpha);
  p.setStyle(1); // PaintStyle.Stroke
  p.setStrokeWidth(width);
  p.setStrokeCap(1); // StrokeCap.Round
  p.setStrokeJoin(1); // StrokeJoin.Round
  return p;
};

/** Scale about a point, then translate: the shape enter() and exit() describe. */
const around = (canvas: SkCanvas, x: number, y: number, scale: number, dy: number) => {
  'worklet';
  canvas.translate(x, y + dy);
  canvas.scale(scale, scale);
  canvas.translate(-x, -y);
};

const digit = (canvas: SkCanvas, d: number, x: number, y: number, paint: SkPaint) => {
  'worklet';
  for (const s of DIGITS[d].split('')) {
    const path = Skia.Path.MakeFromSVGString(SEGMENTS[s]);
    if (!path) continue;
    canvas.save();
    canvas.translate(x, y);
    canvas.drawPath(path, paint);
    canvas.restore();
  }
};

export function draw(canvas: SkCanvas, ch: Channels, size: { width: number; height: number }) {
  'worklet';
  canvas.drawRect(Skia.XYWHRect(0, 0, size.width, size.height), fill(COLOR.bg));

  // 1. The seal: one disc carried from the boot screen to the medallion, then into the badge.
  const r = ch.sealSide / 2;
  canvas.drawCircle(ch.sealX + r, ch.sealY + r, r, fill(COLOR.seal));
  canvas.drawCircle(ch.sealX + r, ch.sealY + r, r * 0.78, stroke(COLOR.ring, Math.max(1.5, r * 0.05)));

  // The title's line rises under the medallion.
  if (ch.titleOpacity > 0.001) {
    canvas.save();
    around(canvas, TITLE.x + TITLE.w / 2, TITLE.y + TITLE.h / 2, ch.titleScale, ch.titleY);
    canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(TITLE.x, TITLE.y, TITLE.w, TITLE.h), 10, 10), fill(COLOR.title, ch.titleOpacity));
    canvas.restore();
  }

  // 2. The list's other rows, then the card that is carried into the detail frame.
  if (ch.listOpacity > 0.001) {
    canvas.save();
    around(canvas, 195, 360, ch.listScale, ch.listY);
    for (const y of LIST_ROWS) canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(LIST_CARD.x, y, LIST_CARD.w, LIST_CARD.h), 18, 18), fill(COLOR.row, ch.listOpacity));
    canvas.restore();
  }
  if (ch.cardOpacity > 0.001) canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(ch.cardX, ch.cardY, ch.cardW, ch.cardH), 18, 18), fill(COLOR.card, ch.cardOpacity));
  if (ch.detailOpacity > 0.001) {
    canvas.save();
    around(canvas, 195, DETAIL_CARD.y + DETAIL_CARD.h + 40, ch.detailScale, ch.detailY);
    for (const i of [0, 1]) {
      canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(DETAIL_CARD.x + 20, DETAIL_CARD.y + DETAIL_CARD.h + 24 + i * 70, DETAIL_CARD.w - 40, 48), 14, 14), fill(COLOR.row, ch.detailOpacity));
    }
    canvas.restore();
  }

  // 3. One rounded box: the button, pressed, becomes the sheet.
  const sheetOn = ch.btnH > 60;
  canvas.save();
  around(canvas, ch.btnX + ch.btnW / 2, ch.btnY + ch.btnH / 2, ch.btnScale, 0);
  canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(ch.btnX, ch.btnY, ch.btnW, ch.btnH), ch.btnR, ch.btnR), fill(sheetOn ? COLOR.sheet : COLOR.button));
  canvas.restore();

  if (!sheetOn || ch.sheetTextOpacity < 0.001) return;
  canvas.save();
  around(canvas, 195, 700, ch.sheetTextScale, ch.sheetTextY);
  const a = ch.sheetTextOpacity;

  // 4. The check draws on.
  const check = Skia.Path.MakeFromSVGString(CHECK);
  if (check) canvas.drawPath(drawOn(check, ch.check), stroke(COLOR.check, 8, a));

  // 5. The count rolls: each digit place is a clipped strip; the digit rolls up and the next one rolls in.
  const rl = roll(COUNT.from, COUNT.to, ch.countP);
  const places = rl.digits.length;
  const countX = SHEET.x + SHEET.w / 2 - (places * PLACE_W) / 2;
  const countY = 668;
  const ink = stroke(COLOR.ink, 4, a);
  for (let k = 0; k < places; k++) {
    const x = countX + (places - 1 - k) * PLACE_W;
    const off = rl.offsets[k] * DIGIT_H;
    canvas.save();
    canvas.clipRect(Skia.XYWHRect(x - 4, countY, PLACE_W, DIGIT_H + 4), ClipOp.Intersect, true);
    digit(canvas, rl.digits[k], x, countY - off, ink);
    digit(canvas, (rl.digits[k] + 1) % 10, x, countY + DIGIT_H + 8 - off, ink);
    canvas.restore();
  }

  // 6. The word's points morph into the numeral's. Sampled each frame: no cache is kept inside a worklet.
  const word = Skia.Path.MakeFromSVGString(WORD);
  const numeral = Skia.Path.MakeFromSVGString(NUMERAL);
  if (word && numeral) {
    const dots = morphPoints(sortPoints(pathPoints(word, POINTS), 'x'), sortPoints(pathPoints(numeral, POINTS), 'x'), ch.wordP, { path: 'arc', stagger: 'x', seed: 1 });
    const dot = fill(COLOR.ink, a);
    for (const p of dots) canvas.drawCircle(p.x, p.y, 2 * p.size, dot);
  }
  canvas.restore();
}
