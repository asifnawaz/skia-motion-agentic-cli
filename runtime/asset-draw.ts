import {
  BlendMode, BlurStyle, ClipOp, FilterMode, MipmapMode, PaintStyle, Skia, StrokeCap, StrokeJoin, TextAlign, TextDirection, TileMode, VertexMode,
  type SkCanvas, type SkData, type SkImage, type SkPaint, type SkParagraph, type SkPath, type SkShader, type SkTypeface, type SkTypefaceFontProvider,
} from 'react-native-skia';
import { MAX_FEATHER, resolveAssetColor, resolveAssetFonts, usedAssetImages, type AssetNode, type AssetStroke, type AssetTextNode, type DrawableMotionAsset, type MotionAsset, type PathCommand } from './asset';
import type { AssetResource } from './asset-binary';
import { fitAsset, fittedAnchorOffset, type AssetLayoutOptions } from './asset-layout';
import { meshPinPosition, meshPosition, type MeshNode, type MeshPin } from './asset-mesh';
import { digitText, restText, rollFrame, rollSpan, rollTextStyle, rollWidthShare, SMEAR_SIGMA, type RollTiming } from './asset-roll';
import { blendInk, plateBox, rowItems, rowLayout, textInk, type Box, type RowChild, type TextInk } from './asset-ink';

type Channels = Readonly<Record<string, number>>;
type Palette = Readonly<Record<string, string>>;
type Point = ReturnType<typeof meshPosition>;
type DrawablePin = Omit<MeshPin, 'children'> & { children: readonly DrawableNode[] };
type DrawableMesh = Omit<MeshNode, 'pins'> & {
  pins?: readonly DrawablePin[];
  fixedPositions?: Point[];
  textureCoords?: Point[];
};
type DrawableNode =
  | (Omit<Extract<AssetNode, { kind: 'group' }>, 'children'> & {
      children: readonly DrawableNode[];
      preparedClip?: SkPath;
      /** A row's embedded images' ink, as fractions of their boxes, by child; none for a host image slot. */
      rowParts?: readonly (Box | undefined)[];
    })
  | DrawableMesh
  | (AssetTextNode & { paragraph?: SkParagraph })
  | (DrawableShape & { preparedPath?: SkPath; preparedPaint?: SkPaint });

type DrawableShape = Exclude<AssetNode, { kind: 'group' | 'mesh' | 'text' }>;
type TextValues = Readonly<Record<string, string>>;

export type DrawableAsset = Pick<MotionAsset, 'channels'> & {
  artboard: Omit<MotionAsset['artboard'], 'nodes'> & { nodes: readonly DrawableNode[] };
  meshShaders?: AssetMeshShaders;
  fontProvider?: SkTypefaceFontProvider;
  textBindings?: readonly string[];
  palette?: Palette;
};
export type AssetImages = Readonly<Record<string, SkImage>>;
export type AssetFontSlots = Readonly<Record<string, SkTypeface>>;
export type AssetMeshShaders = Readonly<Record<string, SkShader>>;

function skiaData(resource: AssetResource): SkData {
  if (typeof resource === 'string') return Skia.Data.fromBase64(resource.slice(resource.indexOf(',') + 1));
  const { bytes } = resource;
  // Skia v3 reads the whole backing buffer. Give it only this resource.
  return Skia.Data.fromBytes(bytes.byteOffset === 0 && bytes.length === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes));
}

/** Decode on the JS thread once per loaded file. Only the native images enter the UI worklet. */
export function decodeAssetImages(asset: DrawableMotionAsset, slots: AssetImages = {}): AssetImages {
  for (const name of Object.keys(slots)) {
    if (!asset.imageSlots || !Object.hasOwn(asset.imageSlots, name)) throw new Error(`Unknown motion image slot "${name}"`);
  }
  if (!asset.images) return {};
  // Skia v3 renamed this factory after 3.0. Keep both names usable at the peer dependency floor.
  const factory = Skia.Image as {
    MakeFromEncoded?: (data: SkData) => SkImage | null;
    MakeImageFromEncoded?: (data: SkData) => SkImage | null;
  };
  const byResource = new Map<AssetResource, SkImage>();
  const embedded = asset.images;
  const used = usedAssetImages(asset.artboard.nodes);
  return Object.fromEntries(Array.from(used, (name) => {
    if (Object.hasOwn(slots, name)) return [name, slots[name]!];
    const resource = embedded[asset.imageSlots?.[name] ?? name]!;
    const previous = byResource.get(resource);
    if (previous) return [name, previous];
    const data = skiaData(resource);
    const image = factory.MakeFromEncoded ? factory.MakeFromEncoded(data) : factory.MakeImageFromEncoded?.(data);
    if (!image) throw new Error(`images.${name}: could not decode the embedded image`);
    byResource.set(resource, image);
    return [name, image];
  }));
}

function read(value: string | number | undefined, channels: Channels, fallback = 0): number {
  'worklet';
  if (value === undefined) return fallback;
  return typeof value === 'string' ? channels[value]! : value;
}

function makePath(commands: readonly PathCommand[], channels: Channels) {
  'worklet';
  const path = Skia.PathBuilder.Make();
  for (const [op, ...coords] of commands) {
    const args = coords.map((coord) => read(coord, channels));
    if (op === 'M') path.moveTo(args[0]!, args[1]!);
    else if (op === 'L') path.lineTo(args[0]!, args[1]!);
    else if (op === 'Q') path.quadTo(args[0]!, args[1]!, args[2]!, args[3]!);
    else if (op === 'C') path.cubicTo(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!);
    else path.close();
  }
  return path.detach();
}

function makePaint(node: DrawableShape, alpha: number, channels: Channels, palette: Palette): SkPaint {
  'worklet';
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  if (node.kind === 'image') {
    paint.setAlphaf(alpha);
    return paint;
  }
  const feather = Math.min(MAX_FEATHER, read(node.feather, channels));
  if (feather > 0) paint.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, feather, true));
  if (!node.fill) return paint;
  if (typeof node.fill === 'string' || 'palette' in node.fill) {
    const color = Skia.Color(resolveAssetColor(node.fill, palette));
    paint.setColor(color);
    paint.setAlphaf(alpha * color[3]!);
  } else {
    const light = node.fill;
    const center = { x: read(light.x, channels), y: read(light.y, channels) };
    const radius = Math.max(0.001, read(light.radius, channels));
    const colors = light.colors.map((color) => Skia.Color(color));
    paint.setShader(Skia.Shader.MakeRadialGradient(center, radius, colors, null, TileMode.Clamp));
    paint.setAlphaf(alpha);
  }
  return paint;
}

function preparePaint(node: DrawableShape, palette: Palette): SkPaint | undefined {
  if (typeof node.opacity === 'string' || node.opacity === 0) return undefined;
  if (node.kind !== 'image') {
    if (typeof node.feather === 'string') return undefined;
    const light = node.fill;
    if (!light || (typeof light !== 'string' && 'kind' in light && [light.x, light.y, light.radius].some((value) => typeof value === 'string'))) {
      return undefined;
    }
  }
  return makePaint(node, node.opacity ?? 1, {}, palette);
}

function meshTextureCoords(node: MeshNode | DrawableMesh, image: SkImage): Point[] {
  'worklet';
  const width = image.width();
  const height = image.height();
  return node.vertices.map(([, , u, v]) => ({ x: u * width, y: v * height }));
}

function meshShader(image: SkImage): SkShader {
  'worklet';
  return image.makeShaderOptions(TileMode.Decal, TileMode.Decal, FilterMode.Linear, MipmapMode.None);
}

/**
 * Lay out a text node's paragraph. `text` is the whole string, or runs of it each shown or laid out unseen (a rolling number keeps its
 * digits' place in the line while it draws them itself).
 */
function makeParagraph(
  node: AssetTextNode, text: string | readonly (readonly [string, boolean])[], provider?: SkTypefaceFontProvider,
): SkParagraph {
  'worklet';
  const builder = Skia.ParagraphBuilder.Make({
    textDirection: node.direction === 'rtl' ? TextDirection.RTL : TextDirection.LTR,
    textAlign: node.align === 'center' ? TextAlign.Center : node.align === 'end' ? TextAlign.End : TextAlign.Start,
    maxLines: node.maxLines ?? 1,
    ellipsis: '…',
  }, node.fonts?.length ? provider : undefined);
  const runs = typeof text === 'string' ? [[text, true] as const] : text;
  for (const [content, shown] of runs) {
    if (!content) continue;
    builder.pushStyle({
      color: Skia.Color(shown ? node.fill : 'rgba(0,0,0,0)'), fontSize: node.fontSize,
      ...(node.fonts?.length ? { fontFamilies: [...node.fonts] } : {}),
      ...(node.fontFeatures?.length ? { fontFeatures: [...node.fontFeatures] } : {}),
    });
    builder.addText(content);
    builder.pop();
  }
  const paragraph = builder.build();
  paragraph.layout(node.width);
  return paragraph;
}

/** The baseline of a paragraph's first line, from its top. */
function baselineOf(paragraph: SkParagraph): number {
  'worklet';
  return paragraph.getLineMetrics()[0]?.baseline ?? 0;
}

/** The left edge of a range of a laid-out paragraph, in its own coordinates. */
function rangeLeft(paragraph: SkParagraph, start: number, end: number): number {
  'worklet';
  let left = Infinity;
  for (const rect of paragraph.getRectsForRange(start, end)) left = Math.min(left, rect.x);
  return left === Infinity ? 0 : left;
}

// A roll as drawn: its timing, and the ASCII digit columns prepareAssetDrawing laid out once.
type RollDrawing = { progress: string; from: string; digits?: readonly SkParagraph[] } & RollTiming;

/**
 * A rolling number (`roll` on a text node). At rest it is the plain paragraph of the number it shows, with tabular figures. While it rolls,
 * Skia lays out the same paragraph with zeros in the digit places, which places the prefix, the digit run and the suffix by the node's own
 * alignment and direction; each digit place is then a column clipped to one line, the current digit leaving upward as the next comes in
 * from below. A blank leading place opens as its digit arrives, so the layout eases between the shorter and the longer number. Values the
 * odometer cannot roll (two runs of digits, different prefixes) cut from one to the other at half way.
 */
function drawRoll(
  canvas: SkCanvas, node: AssetTextNode & { roll: RollDrawing }, channels: Channels, values: TextValues,
  fonts: SkTypefaceFontProvider | undefined, text: string,
): void {
  'worklet';
  const progress = read(node.roll.progress, channels);
  const from = values[node.roll.from] ?? '';
  const x = read(node.x, channels);
  const y = read(node.y, channels);
  const styled = rollTextStyle(node);
  const frame = rollFrame(from, text, progress, node.roll);
  if (!frame) {
    const content = progress < 0.5 ? from : text;
    if (content) makeParagraph(styled, content, fonts).paint(canvas, x, y);
    return;
  }
  let full = 0;
  let opening = 0;
  for (const { current, turn } of frame.places) {
    if (current >= 0) full++;
    else opening = Math.max(opening, turn);
  }
  // At rest (no place turning or smearing) the roll is its plain text. A fast roll passing a whole value still smears.
  if (!opening && frame.places.every(({ turn, smear }) => turn === 0 && smear === 0)) {
    // At either end it is exactly the string the host set (zero padding and all); between whole values, the value it rests on.
    makeParagraph(styled, progress <= 0 ? from : progress >= 1 ? text : restText(frame), fonts).paint(canvas, x, y);
    return;
  }
  const zero = digitText(0, frame.zero);
  const start = frame.prefix.length;
  // The number laid out with zeros in its digit places, unseen; the prefix and suffix are drawn in it, so they keep their shaping in context.
  const layoutOf = (count: number, prefix: boolean, suffix: boolean) => {
    let zeros = '';
    for (let i = 0; i < count; i++) zeros += zero;
    const paragraph = makeParagraph(styled, [[frame.prefix, prefix], [zeros, false], [frame.suffix, suffix]], fonts);
    const end = start + count * zero.length;
    return {
      paragraph,
      baseline: baselineOf(paragraph),
      height: paragraph.getHeight(),
      prefix: frame.prefix ? rangeLeft(paragraph, 0, start) : 0,
      digits: rangeLeft(paragraph, start, end),
      suffix: frame.suffix ? rangeLeft(paragraph, end, end + frame.suffix.length) : 0,
    };
  };
  const now = layoutOf(full, true, !opening);
  const then = opening > 0 ? layoutOf(full + 1, false, false) : now;
  const at = (key: 'prefix' | 'digits' | 'suffix') => x + now[key] + (then[key] - now[key]) * opening;
  // While a place opens, the prefix and the suffix move apart by different amounts, so each is drawn from its own copy of the layout.
  now.paragraph.paint(canvas, at('prefix') - now.prefix, y);
  if (opening && frame.suffix) layoutOf(full, false, true).paragraph.paint(canvas, at('suffix') - now.suffix, y);
  // Digits draw left to right in their own paragraphs, the layout having put the run in reading order. Each sits on the whole number's
  // baseline: a digit alone can take a different line box.
  const baseline = y + now.baseline;
  const line = now.height;
  const plain: AssetTextNode = { ...styled, align: 'start', direction: 'ltr', maxLines: 1 };
  // ASCII digits come from the columns prepared once; another digit system lays its digit out here.
  const prepared = frame.zero === 48 ? node.roll.digits : undefined;
  const column = (digit: number) => prepared?.[digit] ?? makeParagraph(plain, digitText(digit, frame.zero), fonts);
  const piece = (digit: number, left: number, drop = 0) => {
    const paragraph = column(digit);
    paragraph.paint(canvas, left, baseline - baselineOf(paragraph) + drop);
  };
  const advance = column(0).getLongestLine();
  let edge = at('digits');
  frame.places.forEach(({ current, next, turn, smear }) => {
    const width = current < 0 ? turn * advance : advance;
    edge += width;
    if (width <= 0) return;
    // Each digit sits against its column's right edge, so an opening place slides in beside the digit after it.
    const left = edge - advance;
    canvas.save();
    canvas.clipRect(Skia.XYWHRect(edge - width, y, width, line), ClipOp.Intersect, true);
    // A place turning too fast to read is drawn as a vertical blur of its column; it sharpens as it slows into the value.
    if (smear > 0) {
      const blur = Skia.Paint();
      blur.setImageFilter(Skia.ImageFilter.MakeBlur(0, smear * line * SMEAR_SIGMA, TileMode.Decal, null));
      canvas.saveLayer(blur);
    }
    if (current >= 0) piece(current, left, -turn * line);
    if (turn > 0 && next >= 0) piece(next, left, (1 - turn) * line);
    if (smear > 0) canvas.restore();
    canvas.restore();
  });
}

function prepareNode(
  node: AssetNode, images: AssetImages, shaders: Record<string, SkShader>, shadersByImage: Map<SkImage, SkShader>,
  provider: SkTypefaceFontProvider | undefined, textBindings: Set<string>, palette: Palette,
): DrawableNode {
  if (node.kind === 'text') {
    if (typeof node.text === 'string') return { ...node, paragraph: makeParagraph(node, node.text, provider) };
    textBindings.add(node.text.value);
    if (node.roll) textBindings.add(node.roll.from);
    return node;
  }
  const commands = node.kind === 'group' ? node.clip : node.kind === 'path' ? node.commands : undefined;
  const prepared = commands?.every(([, ...coordinates]) => coordinates.every((value) => typeof value === 'number'))
    ? makePath(commands, {})
    : undefined;
  if (node.kind === 'group') {
    const { points: _points, ...drawing } = node;
    return { ...drawing, preparedClip: prepared, children: node.children.map((child) =>
      prepareNode(child, images, shaders, shadersByImage, provider, textBindings, palette)) };
  }
  if (node.kind === 'mesh') {
    const image = images[node.image];
    if (image && !Object.hasOwn(shaders, node.image)) {
      const shader = shadersByImage.get(image) ?? meshShader(image);
      shadersByImage.set(image, shader);
      shaders[node.image] = shader;
    }
    const pins = node.pins && Object.values(node.pins).filter((pin) => pin.children?.length).map((pin) => ({
      ...pin,
      children: pin.children!.map((child) => prepareNode(child, images, shaders, shadersByImage, provider, textBindings, palette)),
    }));
    const fixed = node.vertices.every(([x, y]) => typeof x === 'number' && typeof y === 'number');
    return {
      ...node, pins,
      fixedPositions: fixed ? node.vertices.map((vertex) => meshPosition(vertex, {})) : undefined,
      textureCoords: image ? meshTextureCoords(node, image) : undefined,
    };
  }
  return { ...node, preparedPath: prepared, preparedPaint: preparePaint(node, palette) };
}

/** Build fixed geometry and paints once. Channel-driven paths and clips are still evaluated for each pose. */
export function prepareAssetDrawing(asset: DrawableMotionAsset, images: AssetImages = {}, fontSlots?: AssetFontSlots): DrawableAsset {
  const { fonts, missing } = resolveAssetFonts(asset, fontSlots);
  if (missing.length) throw new Error(`Missing motion font slots: ${missing.join(', ')}`);
  const shaders: Record<string, SkShader> = {};
  const shadersByImage = new Map<SkImage, SkShader>();
  let fontProvider: SkTypefaceFontProvider | undefined;
  const typefaces = new Map<AssetResource, SkTypeface>();
  for (const [name, resource] of Object.entries(fonts)) {
    fontProvider ??= Skia.TypefaceFontProvider.Make();
    if (typeof resource !== 'string' && !('bytes' in resource)) {
      fontProvider.registerFont(resource, name);
      continue;
    }
    let typeface = typefaces.get(resource);
    if (!typeface) {
      const data = skiaData(resource);
      // Match the renamed factory while retaining the Skia 3.0 peer floor.
      const factory = Skia.Typeface as {
        MakeFromData?: (data: SkData) => SkTypeface | null;
        MakeFreeTypeFaceFromData?: (data: SkData) => SkTypeface | null;
      };
      const decoded = factory.MakeFromData ? factory.MakeFromData(data) : factory.MakeFreeTypeFaceFromData?.(data);
      if (!decoded) throw new Error(`fonts.${name}: Skia could not decode the font`);
      typefaces.set(resource, decoded);
      typeface = decoded;
    }
    fontProvider.registerFont(typeface, name);
  }
  const textBindings = new Set<string>();
  const palette = asset.palette ?? {};
  // A row's embedded images carry their alpha ink (pack writes it); a host image slot is placed by its box, as check places it.
  const withParts = (node: DrawableNode): DrawableNode => {
    // A roll smears by how fast its places turn, which needs the time its progress channel takes (rollSpan).
    // Its ASCII digit columns are laid out once here, so a frame of the roll builds only the number's own layout, not a paragraph per place.
    if (node.kind === 'text' && node.roll) {
      const plain = { ...rollTextStyle(node), align: 'start', direction: 'ltr', maxLines: 1 } as AssetTextNode;
      const digits = Array.from({ length: 10 }, (_, digit) => makeParagraph(plain, String(digit), fontProvider));
      return { ...node, roll: { ...node.roll, ms: rollSpan(asset.clips, node.roll.progress), digits } } as DrawableNode;
    }
    // Nodes on a mesh pin are drawn like a group's children, so they are prepared the same way.
    if (node.kind === 'mesh') return node.pins ? { ...node, pins: node.pins.map((pin) => ({ ...pin, children: pin.children.map(withParts) })) } : node;
    if (node.kind !== 'group') return node;
    const children = node.children.map(withParts);
    if (!node.row) return { ...node, children };
    const rowParts = node.children.map((child) => (child.kind === 'image' && !asset.imageSlots?.[child.image] ? asset.imageInk?.[child.image] as Box | undefined : undefined));
    return { ...node, children, rowParts };
  };
  const nodes = asset.artboard.nodes.map((node) => withParts(prepareNode(node, images, shaders, shadersByImage, fontProvider, textBindings, palette)));
  return {
    channels: asset.channels, artboard: { ...asset.artboard, nodes }, meshShaders: shaders,
    ...(fontProvider && { fontProvider }),
    ...(textBindings.size && { textBindings: [...textBindings] }),
    ...(asset.palette && { palette }),
  };
}

/** Warmed images may be different native objects. Prepare their shaders with the same geometry. */
export function rebindAssetMeshShaders(drawing: DrawableAsset, images: AssetImages): DrawableAsset {
  const names = Object.keys(drawing.meshShaders ?? {});
  if (!names.length) return drawing;
  const byImage = new Map<SkImage, SkShader>();
  const meshShaders = Object.fromEntries(names.map((name) => {
    const image = images[name]!;
    const shader = byImage.get(image) ?? meshShader(image);
    byImage.set(image, shader);
    return [name, shader];
  }));
  return { ...drawing, meshShaders };
}

function drawMesh(canvas: SkCanvas, node: DrawableMesh, channels: Channels, image: SkImage, alpha: number, shader: SkShader | undefined) {
  'worklet';
  const positions = node.fixedPositions ?? node.vertices.map((vertex) => meshPosition(vertex, channels));
  const textures = node.textureCoords ?? meshTextureCoords(node, image);
  const paint = Skia.Paint();
  paint.setAlphaf(alpha);
  paint.setShader(shader ?? meshShader(image));
  const mesh = Skia.MakeVertices(VertexMode.Triangles, positions, textures, undefined, node.indices as number[]);
  canvas.drawVertices(mesh, BlendMode.SrcOver, paint);
}

function drawStroke(
  canvas: SkCanvas, path: SkPath, stroke: AssetStroke, alpha: number, feather: number, channels: Channels, palette: Palette,
): void {
  'worklet';
  const width = Math.min(4096, read(stroke.width, channels));
  if (!(width > 0)) return;
  const start = Math.max(0, Math.min(1, read(stroke.trim?.start, channels)));
  const end = Math.max(0, Math.min(1, read(stroke.trim?.end, channels, 1)));
  if (end <= start) return;
  const trimmed = start === 0 && end === 1 ? path : Skia.Path.Trim(path, start, end, false);
  if (!trimmed) return;
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  const color = Skia.Color(resolveAssetColor(stroke.color, palette));
  paint.setColor(color);
  paint.setAlphaf(alpha * color[3]!);
  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeWidth(width);
  paint.setStrokeCap(stroke.cap === 'round' ? StrokeCap.Round : stroke.cap === 'square' ? StrokeCap.Square : StrokeCap.Butt);
  paint.setStrokeJoin(stroke.join === 'round' ? StrokeJoin.Round : stroke.join === 'bevel' ? StrokeJoin.Bevel : StrokeJoin.Miter);
  if (stroke.dash) paint.setPathEffect(Skia.PathEffect.MakeDash([...stroke.dash.intervals], read(stroke.dash.phase, channels)));
  if (feather > 0) paint.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, feather, true));
  canvas.drawPath(trimmed, paint);
}

/** One run of glyphs as `SkParagraph.extendedVisit` (react-native-skia 3.10.2 and later) reports it: typed here, so the runtime typechecks
 * against older react-native-skia, which lacks the method. */
type VisitedRun = {
  font: { measureText(text: string): { y: number } };
  origin: { x: number; y: number };
  glyphs: ArrayLike<number>;
  positions: ArrayLike<{ x: number; y: number }>;
  bounds: ArrayLike<{ x: number; y: number; width: number; height: number }>;
};
type WithVisit = { extendedVisit?: (visitor: (line: number, run: VisitedRun | null) => void) => void };
type WithMatch = { matchFamilyStyle?: (name: string, style: Record<string, never>) => SkTypeface | null };
/** A face's cap height, when the font is not known, as a share of the font size. */
const CAP_SHARE = 0.7;

/**
 * A laid-out text's ink and optical band, from the glyphs Skia placed and the first run's face: asset-ink.ts's rule, as check uses it.
 * Without extendedVisit (react-native-skia before 3.10.2, or React Native Web, where it throws) the ink is approximate: the line's
 * advance boxes from the cap height above the baseline down to it, the cap height read from the node's first font (asset check warns
 * row-approx).
 */
function paragraphInk(paragraph: SkParagraph, text: string, node: AssetTextNode, fonts: SkTypefaceFontProvider | undefined): TextInk | undefined {
  'worklet';
  const lines = paragraph.getLineMetrics();
  const first = lines[0]?.baseline ?? 0;
  const last = lines[lines.length - 1]?.baseline ?? 0;
  const glyphs: Box[] = [];
  let heights = { cap: 0, x: 0 };
  const visit = (paragraph as unknown as WithVisit).extendedVisit;
  if (typeof visit === 'function') {
    try {
      let faced = false;
      visit.call(paragraph, (_line, info) => {
        if (!info) return;
        if (!faced) {
          faced = true;
          heights = { cap: Math.max(0, -info.font.measureText('H').y), x: Math.max(0, -info.font.measureText('x').y) };
        }
        for (let i = 0; i < info.glyphs.length; i++) {
          const at = info.positions[i]!;
          const bounds = info.bounds[i]!;
          const x = info.origin.x + at.x + bounds.x;
          const y = info.origin.y + at.y + bounds.y;
          glyphs.push([x, y, x + bounds.width, y + bounds.height]);
        }
      });
      return textInk(glyphs, first, last, text, heights);
    } catch {
      glyphs.length = 0; // React Native Web: the method is there and throws
    }
  }
  const match = (fonts as unknown as WithMatch | undefined)?.matchFamilyStyle;
  const family = node.fonts?.[0];
  const face = typeof match === 'function' && family ? match.call(fonts, family, {}) : null;
  if (face) {
    const font = Skia.Font(face, node.fontSize);
    heights = { cap: Math.max(0, -font.measureText('H').y), x: Math.max(0, -font.measureText('x').y) };
  }
  if (!heights.cap) heights = { cap: node.fontSize * CAP_SHARE, x: 0 };
  for (const rect of paragraph.getRectsForRange(0, text.length)) {
    if (rect.width > 0) glyphs.push([rect.x, first - heights.cap, rect.x + rect.width, last]);
  }
  return textInk(glyphs, first, last, text, heights);
}

type RowGroup = Extract<DrawableNode, { kind: 'group' }> & { row: NonNullable<Extract<AssetNode, { kind: 'group' }>['row']> };

/**
 * Lay out a `row` group by its children's ink and optical centres (asset-ink.ts) and draw its plate; drawNodes then draws each child moved
 * by its move (Worklets capture helpers when they are defined, so this one cannot call drawNodes back).
 */
function layoutRow(
  canvas: SkCanvas, node: RowGroup, channels: Channels, values: TextValues, fonts: SkTypefaceFontProvider | undefined, palette: Palette,
): { moves: [number, number][]; paragraphs: (SkParagraph | undefined)[] } {
  'worklet';
  const { row } = node;
  const align = row.align ?? 'start';
  const rtl = row.direction === 'rtl';
  const paragraphs: (SkParagraph | undefined)[] = [];
  const children = node.children as unknown as readonly RowChild[];
  const { items, widest, bands } = rowItems(children, (value, fallback) => read(value, channels, fallback), (child, index, wide) => {
    const drawn = node.children[index] as AssetTextNode & { paragraph?: SkParagraph };
    const text = wide ? row.plate!.widest! : typeof drawn.text === 'string' ? drawn.text : values[drawn.text.value] ?? '';
    if (drawn.roll && !wide) {
      // A rolling count is placed between its old value's ink and its new one's, so at rest it is placed by the value it shows.
      const styled = rollTextStyle(drawn);
      const from = values[drawn.roll.from] ?? '';
      const inkOf = (value: string) => (value ? paragraphInk(makeParagraph(styled, value, fonts), value, styled, fonts) : undefined);
      return blendInk(inkOf(from), inkOf(text), rollWidthShare(from, text, read(drawn.roll.progress, channels), drawn.roll));
    }
    if (!text) return undefined;
    const paragraph = !wide && drawn.paragraph ? drawn.paragraph : makeParagraph(rollTextStyle(drawn), text, fonts);
    if (!wide) paragraphs[index] = paragraph;
    return paragraphInk(paragraph, text, drawn, fonts);
  }, (index) => node.rowParts?.[index], Boolean(row.plate?.widest));
  const { moves } = rowLayout(items, row.gap, align, rtl);
  if (row.plate) {
    const box = plateBox(widest, bands, row.gap, align, rtl, row.plate.padding);
    const rect = Skia.XYWHRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    const radius = Math.min(row.plate.radius ?? Infinity, (box[2] - box[0]) / 2, (box[3] - box[1]) / 2);
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setColor(Skia.Color(resolveAssetColor(row.plate.fill, palette)));
    canvas.drawRRect(Skia.RRectXY(rect, radius, radius), paint);
    if (row.plate.stroke && row.plate.stroke.width > 0) {
      const edge = Skia.Paint();
      edge.setAntiAlias(true);
      edge.setStyle(PaintStyle.Stroke);
      edge.setStrokeWidth(row.plate.stroke.width);
      edge.setColor(Skia.Color(resolveAssetColor(row.plate.stroke.color, palette)));
      canvas.drawRRect(Skia.RRectXY(rect, radius, radius), edge);
    }
  }
  return { moves, paragraphs };
}

function drawNodes(
  canvas: SkCanvas, nodes: readonly DrawableNode[], channels: Channels, images: AssetImages, shaders: AssetMeshShaders,
  values: TextValues, fonts: SkTypefaceFontProvider | undefined, palette: Palette, layout?: ReturnType<typeof fitAsset>,
): void {
  'worklet';
  for (const node of nodes) {
    if (node.kind === 'group') {
      const offset = fittedAnchorOffset(node.anchor, layout);
      canvas.save();
      canvas.translate(read(node.x, channels) + offset.x, read(node.y, channels) + offset.y);
      canvas.rotate(read(node.rotation, channels), 0, 0);
      canvas.scale(read(node.scaleX, channels, 1), read(node.scaleY, channels, 1));
      if (node.clip) canvas.clipPath(node.preparedClip ?? makePath(node.clip, channels), ClipOp.Intersect, true);
      if (node.row) {
        const { moves, paragraphs } = layoutRow(canvas, node as RowGroup, channels, values, fonts, palette);
        node.children.forEach((child, index) => {
          canvas.save();
          canvas.translate(moves[index]![0], moves[index]![1]);
          const paragraph = paragraphs[index];
          if (child.kind === 'text' && !child.roll && paragraph) paragraph.paint(canvas, read(child.x, channels), read(child.y, channels));
          else drawNodes(canvas, [child], channels, images, shaders, values, fonts, palette);
          canvas.restore();
        });
      } else drawNodes(canvas, node.children, channels, images, shaders, values, fonts, palette);
      canvas.restore();
      continue;
    }
    if (node.kind === 'text') {
      const content = typeof node.text === 'string' ? node.text : values[node.text.value] ?? '';
      if (node.roll) {
        drawRoll(canvas, node as AssetTextNode & { roll: RollDrawing }, channels, values, fonts, content);
        continue;
      }
      if (content) {
        const paragraph = node.paragraph ?? makeParagraph(node, content, fonts);
        paragraph.paint(canvas, read(node.x, channels), read(node.y, channels));
      }
      continue;
    }
    const alpha = Math.min(1, Math.max(0, read(node.opacity, channels, 1)));
    if (node.kind === 'mesh') {
      const image = images[node.image];
      if (image && alpha) drawMesh(canvas, node, channels, image, alpha, shaders[node.image]);
      if (node.pins) {
        for (const pin of node.pins) {
          const { x, y } = meshPinPosition(node, pin, channels);
          canvas.save();
          canvas.translate(x, y);
          drawNodes(canvas, pin.children, channels, images, shaders, values, fonts, palette);
          canvas.restore();
        }
      }
      continue;
    }
    if (!alpha) continue;
    if (node.kind === 'path') {
      const path = node.preparedPath ?? makePath(node.commands, channels);
      if (node.fill) canvas.drawPath(path, node.preparedPaint ?? makePaint(node, alpha, channels, palette));
      if (node.stroke) drawStroke(canvas, path, node.stroke, alpha, Math.min(MAX_FEATHER, read(node.feather, channels)), channels, palette);
      continue;
    }
    const paint = node.preparedPaint ?? makePaint(node, alpha, channels, palette);
    if (node.kind === 'image') {
      const image = images[node.image];
      const width = read(node.width, channels);
      const height = read(node.height, channels);
      if (!image || width <= 0 || height <= 0) continue;
      canvas.drawImageRectOptions(
        image,
        Skia.XYWHRect(0, 0, image.width(), image.height()),
        Skia.XYWHRect(read(node.x, channels), read(node.y, channels), width, height),
        FilterMode.Linear, MipmapMode.None, paint,
      );
      continue;
    }
    const w = read(node.width, channels);
    const h = read(node.height, channels);
    if (w <= 0 || h <= 0) continue;
    const rect = Skia.XYWHRect(read(node.x, channels), read(node.y, channels), w, h);
    if (node.kind === 'ellipse') canvas.drawOval(rect, paint);
    else {
      const radius = Math.min(w / 2, h / 2, Math.max(0, read(node.radius, channels)));
      canvas.drawRRect(Skia.RRectXY(rect, radius, radius), paint);
    }
  }
}

/** Draw the resolved pose inside a viewport, preserving artboard coordinates and aspect ratio. */
export function drawAsset(
  canvas: SkCanvas, asset: DrawableAsset, pose: Channels, width: number, height: number,
  images: AssetImages = {}, values: TextValues = {}, options?: AssetLayoutOptions,
): void {
  'worklet';
  if (width <= 0 || height <= 0) return;
  const board = asset.artboard;
  const layout = fitAsset(board, width, height, options);
  const { scale, offsetX, offsetY, spaceX, spaceY } = layout;
  const anchored = board.nodes.some((node) => node.kind === 'group' && node.anchor);
  canvas.save();
  if (spaceX < 0 || spaceY < 0) canvas.clipRect(Skia.XYWHRect(0, 0, width, height), ClipOp.Intersect, true);
  canvas.translate(offsetX * scale, offsetY * scale);
  canvas.scale(scale, scale);
  const bounds = anchored
    ? Skia.XYWHRect(-offsetX, -offsetY, board.width + spaceX, board.height + spaceY)
    : Skia.XYWHRect(0, 0, board.width, board.height);
  canvas.clipRect(bounds, ClipOp.Intersect, true);
  drawNodes(canvas, board.nodes, { ...asset.channels, ...pose }, images, asset.meshShaders ?? {}, values, asset.fontProvider, asset.palette ?? {}, layout);
  canvas.restore();
}
