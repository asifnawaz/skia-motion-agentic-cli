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
  const paragraph = (built) => ({
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
