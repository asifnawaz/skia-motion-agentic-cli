import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { buildSync } from 'esbuild';
import { loadCanvasKit } from './asset-text-layout.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** CanvasKit has no system fonts: a text node with no fonts of its own draws in this face, as the SVG preview draws in sans-serif. */
const FALLBACK_FAMILY = 'skac-fallback';

let draw;

/**
 * The `react-native-skia` surface the app's draw module uses, over CanvasKit. The app's own runtime/asset-draw.ts then draws in Node with
 * the same Skia: blur, gradients, meshes, clips and paragraphs come out as on the phone, not as an SVG approximation.
 */
export function skiaShim(ck, fallbackFont) {
  const point = (p) => [p.x, p.y];
  const typeface = (bytes) => ({ bytes });
  // RN Skia's SkFont.measureText: the ink of a string at its advances, relative to the pen at the baseline.
  const measuring = (font) => ({
    measureText(text) {
      const ids = font.getGlyphIDs(text);
      const bounds = font.getGlyphBounds(ids);
      const widths = font.getGlyphWidths(ids);
      let pen = 0;
      let box;
      for (let i = 0; i < ids.length; i++) {
        const [l, t, r, b] = [bounds[i * 4] + pen, bounds[i * 4 + 1], bounds[i * 4 + 2] + pen, bounds[i * 4 + 3]];
        if (r > l && b > t) box = box ? [Math.min(box[0], l), Math.min(box[1], t), Math.max(box[2], r), Math.max(box[3], b)] : [l, t, r, b];
        pen += widths[i];
      }
      return box ? { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] } : { x: 0, y: 0, width: 0, height: 0 };
    },
  });
  const paragraph = (built) => ({
    // RN Skia's extendedVisit, from CanvasKit's shaped lines: each run's face, glyph positions and tight glyph bounds.
    extendedVisit(visitor) {
      built.getShapedLines().forEach((line, number) => {
        for (const run of line.runs) {
          if (!run.typeface) continue;
          const font = new ck.Font(run.typeface, run.size);
          try {
            const bounds = font.getGlyphBounds(run.glyphs);
            const count = run.glyphs.length;
            visitor(number, {
              font: measuring(font), origin: { x: 0, y: 0 }, glyphs: Array.from(run.glyphs),
              positions: Array.from({ length: count }, (_, i) => ({ x: run.positions[i * 2], y: run.positions[i * 2 + 1] })),
              bounds: Array.from({ length: count }, (_, i) => ({
                x: bounds[i * 4], y: bounds[i * 4 + 1], width: bounds[i * 4 + 2] - bounds[i * 4], height: bounds[i * 4 + 3] - bounds[i * 4 + 1],
              })),
            });
          } finally {
            font.delete();
          }
        }
        visitor(number, null);
      });
    },
    layout: (width) => built.layout(width),
    paint: (canvas, x, y) => canvas.drawParagraph(built, x, y),
    getHeight: () => built.getHeight(),
    getLongestLine: () => built.getLongestLine(),
    getLineMetrics: () => built.getLineMetrics(),
    getRectsForRange: (start, end) => built.getRectsForRange(start, end, ck.RectHeightStyle.Tight, ck.RectWidthStyle.Tight)
      .map(({ rect }) => ({ x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] })),
  });
  const Skia = {
    Data: {
      fromBase64: (text) => Uint8Array.from(Buffer.from(text, 'base64')),
      fromBytes: (bytes) => bytes,
    },
    Image: { MakeImageFromEncoded: (bytes) => ck.MakeImageFromEncoded(bytes) },
    Typeface: { MakeFreeTypeFaceFromData: typeface },
    TypefaceFontProvider: {
      Make() {
        const provider = ck.TypefaceFontProvider.Make();
        provider.registerFont(fallbackFont, FALLBACK_FAMILY);
        return { native: provider, registerFont: ({ bytes }, family) => provider.registerFont(bytes, family) };
      },
    },
    ParagraphBuilder: {
      Make(style, provider) {
        const fonts = provider ?? Skia.TypefaceFontProvider.Make();
        const builder = ck.ParagraphBuilder.MakeFromFontProvider(new ck.ParagraphStyle({
          textStyle: { color: ck.BLACK, fontFamilies: [FALLBACK_FAMILY] },
          textDirection: style.textDirection, textAlign: style.textAlign, maxLines: style.maxLines, ellipsis: style.ellipsis,
        }), fonts.native);
        return {
          pushStyle: (text) => builder.pushStyle(new ck.TextStyle({
            color: text.color, fontSize: text.fontSize, fontFamilies: [...(text.fontFamilies ?? []), FALLBACK_FAMILY],
            ...(text.fontFeatures && { fontFeatures: text.fontFeatures }),
          })),
          addText: (text) => builder.addText(text),
          pop: () => builder.pop(),
          build: () => paragraph(builder.build()),
        };
      },
    },
    PathBuilder: { Make: () => new ck.PathBuilder() },
    Path: { Trim: (path, start, end, complement) => path.makeTrimmed(start, end, complement) },
    Paint: () => new ck.Paint(),
    Color: (color) => ck.parseColorString(color),
    Shader: {
      MakeRadialGradient: (center, radius, colors, positions, mode) => ck.Shader.MakeRadialGradient(point(center), radius, colors, positions, mode),
    },
    MaskFilter: { MakeBlur: (style, sigma, respectCTM) => ck.MaskFilter.MakeBlur(style, sigma, respectCTM) },
    ImageFilter: { MakeBlur: (sigmaX, sigmaY, mode, input) => ck.ImageFilter.MakeBlur(sigmaX, sigmaY, mode, input ?? null) },
    PathEffect: { MakeDash: (intervals, phase) => ck.PathEffect.MakeDash(intervals, phase) },
    MakeVertices: (mode, positions, textures, colors, indices) => ck.MakeVertices(mode, positions.flatMap(point), textures?.flatMap(point), colors, indices),
    XYWHRect: (x, y, w, h) => ck.XYWHRect(x, y, w, h),
    RRectXY: (rect, rx, ry) => ck.RRectXY(rect, rx, ry),
  };
  return {
    Skia, BlendMode: ck.BlendMode, BlurStyle: ck.BlurStyle, ClipOp: ck.ClipOp, FilterMode: ck.FilterMode, MipmapMode: ck.MipmapMode,
    PaintStyle: ck.PaintStyle, StrokeCap: ck.StrokeCap, StrokeJoin: ck.StrokeJoin, TextAlign: ck.TextAlign, TextDirection: ck.TextDirection,
    TileMode: ck.TileMode, VertexMode: ck.VertexMode,
  };
}

/** The app's draw module, bundled with react-native-skia replaced by the CanvasKit shim. */
async function drawModule() {
  if (draw) return draw;
  const ck = await loadCanvasKit();
  const fallback = readFileSync(join(PACKAGE_ROOT, 'templates', 'fonts', 'allo-1.0.3', 'Allo-Regular.otf'));
  const shim = skiaShim(ck, fallback);
  const { outputFiles } = buildSync({
    entryPoints: [join(PACKAGE_ROOT, 'runtime', 'asset-draw.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18', external: ['react-native-skia'],
  });
  const module = { exports: {} };
  compileFunction(outputFiles[0].text, ['module', 'exports', 'require'])(module, module.exports, (name) => {
    if (name === 'react-native-skia') return shim;
    throw new Error(`asset-draw imports ${name}`);
  });
  draw = { ck, ...module.exports };
  return draw;
}

let counted;

/** Wrap every Skia factory so each call counts as one object made, by name. */
function countingShim(shim) {
  const made = new Map();
  const wrap = (target, prefix) => Object.fromEntries(Object.entries(target).map(([name, value]) => {
    const label = prefix ? `${prefix}.${name}` : name;
    if (typeof value === 'function') {
      return [name, (...args) => { made.set(label, (made.get(label) ?? 0) + 1); return value(...args); }];
    }
    return [name, value && typeof value === 'object' ? wrap(value, label) : value];
  }));
  return { shim: { ...shim, Skia: wrap(shim.Skia, '') }, made };
}

async function countedDrawModule() {
  if (counted) return counted;
  const ck = await loadCanvasKit();
  const fallback = readFileSync(join(PACKAGE_ROOT, 'templates', 'fonts', 'allo-1.0.3', 'Allo-Regular.otf'));
  const { shim, made } = countingShim(skiaShim(ck, fallback));
  const { outputFiles } = buildSync({
    entryPoints: [join(PACKAGE_ROOT, 'runtime', 'asset-draw.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18', external: ['react-native-skia'],
  });
  const module = { exports: {} };
  compileFunction(outputFiles[0].text, ['module', 'exports', 'require'])(module, module.exports, (name) => {
    if (name === 'react-native-skia') return shim;
    throw new Error(`asset-draw imports ${name}`);
  });
  counted = { ck, made, ...module.exports };
  return counted;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const round = (value) => Math.round(value * 1000) / 1000;

/**
 * Play a parsed asset's frames through the app's own draw code over CanvasKit's CPU rasteriser and report what each frame costs:
 * milliseconds (first frame apart, as it holds one-time work) and the Skia objects the draw code makes per frame, which on a phone
 * are allocations on the UI thread and garbage for its collector. Times are relative: a phone's GPU backend differs.
 */
export async function measureAssetFrames(asset, rows, size) {
  const { ck, made, decodeAssetImages, prepareAssetDrawing, drawAsset } = await countedDrawModule();
  const { fontSlots: _resolved, ...resolved } = asset;
  made.clear();
  const prepareStart = performance.now();
  const images = decodeAssetImages(resolved);
  const drawing = prepareAssetDrawing(resolved, images);
  const prepareMs = performance.now() - prepareStart;
  const prepareObjects = [...made.values()].reduce((sum, count) => sum + count, 0);
  const surface = ck.MakeSurface(size.width, size.height);
  if (!surface) throw new Error('CanvasKit could not make a raster surface');
  const canvas = surface.getCanvas();
  const frame = (row) => {
    const text = Object.fromEntries(Object.entries(row.values).filter(([, value]) => typeof value === 'string'));
    canvas.clear(ck.TRANSPARENT);
    const start = performance.now();
    drawAsset(canvas, drawing, row.channels, size.width, size.height, images, text);
    surface.flush();
    return performance.now() - start;
  };
  try {
    made.clear();
    const firstMs = frame(rows[0]);
    made.clear();
    const times = rows.map(frame);
    const perFrame = new Map([...made].map(([name, count]) => [name, count / rows.length]));
    const sorted = [...times].sort((a, b) => a - b);
    const imageBytes = Object.values(images).reduce((sum, image) => sum + image.width() * image.height() * 4, 0);
    return {
      frames: rows.length,
      prepare: { ms: round(prepareMs), objects: prepareObjects },
      firstFrameMs: round(firstMs),
      frameMs: { p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), max: round(sorted.at(-1)) },
      objectsPerFrame: round([...perFrame.values()].reduce((sum, count) => sum + count, 0)),
      byKind: Object.fromEntries([...perFrame].sort((a, b) => b[1] - a[1]).map(([name, count]) => [name, round(count)])),
      images: { decodedBytes: imageBytes, withMipsBytes: Math.round(imageBytes * 4 / 3) },
    };
  } finally {
    surface.delete();
  }
}

/**
 * Draw one pose of a parsed asset with the app's own Skia draw code and return the PNG bytes. `asset.fonts` must already hold every
 * font slot's face (resolveAssetFonts with the host fonts), so the slots are drawn as the plain fonts they resolved to.
 */
export async function renderAssetPNG(asset, channels, values, size, background) {
  const { ck, decodeAssetImages, prepareAssetDrawing, drawAsset } = await drawModule();
  const { fontSlots: _resolved, ...resolved } = asset;
  const images = decodeAssetImages(resolved);
  const drawing = prepareAssetDrawing(resolved, images);
  const surface = ck.MakeSurface(size.width, size.height);
  if (!surface) throw new Error('CanvasKit could not make a raster surface');
  const canvas = surface.getCanvas();
  canvas.clear(background ? ck.parseColorString(background) : ck.TRANSPARENT);
  const text = Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === 'string'));
  drawAsset(canvas, drawing, channels, size.width, size.height, images, text);
  surface.flush();
  const image = surface.makeImageSnapshot();
  const bytes = image.encodeToBytes();
  image.delete();
  surface.delete();
  return Buffer.from(bytes);
}
