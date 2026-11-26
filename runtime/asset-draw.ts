import {
  BlendMode, BlurStyle, ClipOp, FilterMode, MipmapMode, PaintStyle, Skia, StrokeCap, StrokeJoin, TextAlign, TextDirection, TileMode, VertexMode,
  type SkCanvas, type SkData, type SkImage, type SkPaint, type SkParagraph, type SkPath, type SkRect, type SkRRect, type SkShader, type SkTypeface,
  type SkTypefaceFontProvider,
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
  cacheKey?: string;
  fixedPositions?: Point[];
  positionChannels?: readonly string[];
  textureCoords?: Point[];
};
type DrawableNode =
  | (Omit<Extract<AssetNode, { kind: 'group' }>, 'children'> & {
      children: readonly DrawableNode[];
      preparedClip?: SkPath;
      cacheKey?: string;
      /** A row's embedded images' ink, as fractions of their boxes, by child; none for a host image slot. */
      rowParts?: readonly (Box | undefined)[];
    })
  | DrawableMesh
  | (AssetTextNode & { paragraph?: SkParagraph; cacheKey?: string })
  | (DrawableShape & { preparedPath?: SkPath; preparedPaint?: SkPaint; cacheKey?: string });

type DrawableShape = Exclude<AssetNode, { kind: 'group' | 'mesh' | 'text' }>;
type TextValues = Readonly<Record<string, string>>;

export type DrawableAsset = Pick<MotionAsset, 'channels'> & {
  artboard: Omit<MotionAsset['artboard'], 'nodes'> & { nodes: readonly DrawableNode[] };
  meshShaders?: AssetMeshShaders;
  /** Each image's shader for image nodes, sampled through its mip levels (drawImageRect's strict constraint would turn them off). */
  imageShaders?: AssetImageShaders;
  fontProvider?: SkTypefaceFontProvider;
  textBindings?: readonly string[];
  palette?: Palette;
};
export type AssetImages = Readonly<Record<string, SkImage>>;
export type AssetFontSlots = Readonly<Record<string, SkTypeface>>;
export type AssetMeshShaders = Readonly<Record<string, SkShader>>;
/** An image node's shader with the image it samples, so a different image passed at draw time is not drawn with it. */
export type AssetImageShaders = Readonly<Record<string, { image: SkImage; shader: SkShader }>>;
type DrawShaders = { mesh: AssetMeshShaders; image: AssetImageShaders };

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

// Paragraphs, row ink, colors and one paint record per animated node: big files keep their per-frame paints resident.
const CACHE_LIMIT = 1024;
type CacheStore = Map<string, unknown>;

/**
 * The value under `key` on this thread, made once. Each thread (the UI thread, or Node for asset frame) has its own store on its global
 * object: drawing worklets get a copy of every captured object, so a cache held by the drawing would start empty each frame.
 */
function cached<T>(key: string | undefined, make: () => T): T {
  'worklet';
  if (key === undefined) return make();
  const holder = globalThis as unknown as { __skiaMotionCache?: CacheStore };
  const store = holder.__skiaMotionCache ?? (holder.__skiaMotionCache = new Map());
  if (store.has(key)) {
    const hit = store.get(key) as T;
    store.delete(key);
    store.set(key, hit);
    return hit;
  }
  const value = make();
  if (store.size >= CACHE_LIMIT) store.delete(store.keys().next().value as string);
  store.set(key, value);
  return value;
}

/** A node's reused paint, and the inputs its costly parts were last made from, so a frame rebuilds them only when they change. */
type PaintRecord = {
  paint: SkPaint; blur?: number; shaderKey?: string; dash?: number;
  image?: SkImage; shader?: SkShader; vertices?: ReturnType<typeof Skia.MakeVertices>;
  positionChannelValues?: number[];
};

function paintRecord(key: string | undefined): PaintRecord {
  'worklet';
  return cached(key, () => ({ paint: Skia.Paint() }));
}

/** A parsed color, once per color string. Callers read it and never change it. */
function colorOf(value: string) {
  'worklet';
  return cached(`color|${value}`, () => Skia.Color(value));
}

type RectRecord = { x: number; y: number; w: number; h: number; r: number; rect: SkRect; rrect?: SkRRect };

/** A node's rect (and rounded rect), remade only when its box or radius moves: a still shape allocates no Skia rect per frame. */
function rectOf(key: string | undefined, x: number, y: number, w: number, h: number, r = 0): RectRecord {
  'worklet';
  const record = key === undefined ? undefined : cached<RectRecord | undefined>(`rect|${key}`, () => undefined);
  if (record && record.x === x && record.y === y && record.w === w && record.h === h && record.r === r) return record;
  const rect = Skia.XYWHRect(x, y, w, h);
  const next: RectRecord = { x, y, w, h, r, rect, rrect: r > 0 ? Skia.RRectXY(rect, r, r) : undefined };
  if (key !== undefined) {
    const holder = globalThis as unknown as { __skiaMotionCache?: CacheStore };
    holder.__skiaMotionCache?.set(`rect|${key}`, next);
  }
  return next;
}

function setBlur(record: PaintRecord, sigma: number) {
  'worklet';
  const next = sigma > 0 ? sigma : 0;
  if ((record.blur ?? 0) === next) return;
  record.blur = next;
  record.paint.setMaskFilter(next > 0 ? Skia.MaskFilter.MakeBlur(BlurStyle.Normal, next, true) : null);
}

/** The numbers a path is built from, read once: each command's letter (as a code) then its coordinates. */
function pathValues(commands: readonly PathCommand[], channels: Channels): number[] {
  'worklet';
  const values: number[] = [];
  for (const command of commands) {
    values.push(command[0].charCodeAt(0));
    for (let i = 1; i < command.length; i++) values.push(read(command[i] as Parameters<typeof read>[0], channels));
  }
  return values;
}

function buildPath(values: readonly number[]) {
  'worklet';
  const path = Skia.PathBuilder.Make();
  let i = 0;
  while (i < values.length) {
    const op = String.fromCharCode(values[i++]!);
    if (op === 'M') { path.moveTo(values[i]!, values[i + 1]!); i += 2; }
    else if (op === 'L') { path.lineTo(values[i]!, values[i + 1]!); i += 2; }
    else if (op === 'Q') { path.quadTo(values[i]!, values[i + 1]!, values[i + 2]!, values[i + 3]!); i += 4; }
    else if (op === 'C') { path.cubicTo(values[i]!, values[i + 1]!, values[i + 2]!, values[i + 3]!, values[i + 4]!, values[i + 5]!); i += 6; }
    else path.close();
  }
  return path.detach();
}

type PathRecord = { values: number[]; path: SkPath };

/**
 * An animated path. With a key the node keeps its last path and builds a new one only when a command or coordinate changes: a detached
 * path never changes, so the next picture can record the same one. The command letters are compared too, since keys restart in each
 * copy of this module while copies on one thread share the cache.
 */
function makePath(commands: readonly PathCommand[], channels: Channels, key?: string) {
  'worklet';
  const values = pathValues(commands, channels);
  if (key === undefined) return buildPath(values);
  const record = cached<PathRecord | undefined>(`path|${key}`, () => undefined);
  if (record && record.values.length === values.length && record.values.every((value, i) => value === values[i])) return record.path;
  const next: PathRecord = { values, path: buildPath(values) };
  const holder = globalThis as unknown as { __skiaMotionCache?: CacheStore };
  holder.__skiaMotionCache!.set(`path|${key}`, next);
  return next.path;
}

/**
 * A shape's fill paint. With a key (an animated node) the node keeps one paint and resets it each frame, remaking its blur and light only
 * when their values change: a picture records a copy of the paint it draws with, so reuse is safe and the UI thread allocates nothing.
 */
function makePaint(node: DrawableShape, alpha: number, channels: Channels, palette: Palette, key?: string): SkPaint {
  'worklet';
  const record = key === undefined ? { paint: Skia.Paint() } as PaintRecord : paintRecord(`fill|${key}`);
  const paint = record.paint;
  paint.setAntiAlias(true);
  if (node.kind === 'image') {
    paint.setAlphaf(alpha);
    return paint;
  }
  setBlur(record, Math.min(MAX_FEATHER, read(node.feather, channels)));
  if (!node.fill) return paint;
  if (typeof node.fill === 'string' || 'palette' in node.fill) {
    const color = colorOf(resolveAssetColor(node.fill, palette));
    paint.setColor(color);
    paint.setAlphaf(alpha * color[3]!);
  } else {
    const light = node.fill;
    const x = read(light.x, channels);
    const y = read(light.y, channels);
    const radius = Math.max(0.001, read(light.radius, channels));
    const shaderKey = `${x}|${y}|${radius}`;
    if (record.shaderKey !== shaderKey) {
      record.shaderKey = shaderKey;
      const colors = light.colors.map((color) => colorOf(color));
      paint.setShader(Skia.Shader.MakeRadialGradient({ x, y }, radius, colors, null, TileMode.Clamp));
    }
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
  // Mip levels keep art drawn below its size from aliasing.
  return image.makeShaderOptions(TileMode.Decal, TileMode.Decal, FilterMode.Linear, MipmapMode.Linear);
}

/**
 * An image node's shader. react-native-skia's drawImageRectOptions draws with SkCanvas::kStrict_SrcRectConstraint, under which Skia
 * samples no mip levels, so art drawn small aliased whatever mipmap mode it asked for. A shader samples them; Clamp keeps the edges as
 * drawImageRect drew them.
 */
function imageShader(image: SkImage): SkShader {
  'worklet';
  return image.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.Linear);
}

function imageShaders(images: AssetImages): AssetImageShaders {
  const byImage = new Map<SkImage, SkShader>();
  return Object.fromEntries(Object.entries(images).map(([name, image]) => {
    const shader = byImage.get(image) ?? imageShader(image);
    byImage.set(image, shader);
    return [name, { image, shader }];
  }));
}

/** The most laid-out paragraphs, row inks and image paints the drawing thread keeps; the oldest unused one goes first. */

let nextNodeKey = 0;

/** A text's layout key: the node (unique per prepared drawing, so per font provider), the style variant and the text runs. */
function paragraphKey(node: AssetTextNode & { cacheKey?: string }, text: string | readonly (readonly [string, boolean])[]): string | undefined {
  'worklet';
  if (node.cacheKey === undefined) return undefined;
  let runs = '';
  if (typeof text === 'string') runs = text;
  else for (const [content, shown] of text) runs += (shown ? '\x01' : '\x02') + content;
  return `${node.cacheKey}|${node.align ?? ''}|${node.direction ?? ''}|${node.maxLines ?? 1}|${node.fontFeatures?.length ?? 0}|${runs}`;
}

function layOut(
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

/**
 * Lay out a text node's paragraph. `text` is the whole string, or runs of it each shown or laid out unseen (a rolling number keeps its
 * digits' place in the line while it draws them itself).
 */
function makeParagraph(
  node: AssetTextNode, text: string | readonly (readonly [string, boolean])[], provider?: SkTypefaceFontProvider,
): SkParagraph {
  'worklet';
  return cached(paragraphKey(node, text), () => layOut(node, text, provider));
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
    const { text } = node;
    if (typeof text === 'string') return { ...node, paragraph: makeParagraph(node, text, provider) };
    textBindings.add(text.value);
    if (node.roll) textBindings.add(node.roll.from);
    return { ...node, cacheKey: `n${nextNodeKey++}` };
  }
  const commands = node.kind === 'group' ? node.clip : node.kind === 'path' ? node.commands : undefined;
  const prepared = commands?.every(([, ...coordinates]) => coordinates.every((value) => typeof value === 'number'))
    ? makePath(commands, {})
    : undefined;
  if (node.kind === 'group') {
    const { points: _points, ...drawing } = node;
    return { ...drawing, preparedClip: prepared, ...((node.row || (node.clip && !prepared)) && { cacheKey: `n${nextNodeKey++}` }), children: node.children.map((child) =>
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
    let positionChannels: Set<string> | undefined;
    for (const [x, y] of node.vertices) {
      if (typeof x === 'string') (positionChannels ??= new Set<string>()).add(x);
      if (typeof y === 'string') (positionChannels ??= new Set<string>()).add(y);
    }
    return {
      ...node, pins, cacheKey: `n${nextNodeKey++}`,
      fixedPositions: positionChannels ? undefined : node.vertices.map((vertex) => meshPosition(vertex, {})),
      positionChannels: positionChannels && Array.from(positionChannels),
      textureCoords: image ? meshTextureCoords(node, image) : undefined,
    };
  }
  if (node.kind === 'image') return { ...node, cacheKey: `n${nextNodeKey++}` };
  // Every shape gets a key: an animated fill or any stroke reuses one paint per node instead of making one each frame.
  return { ...node, preparedPath: prepared, preparedPaint: preparePaint(node, palette), cacheKey: `n${nextNodeKey++}` };
}

declare const __DEV__: boolean | undefined;
const warnedFontSlots = new Set<string>();

/** The nodes with the named font slots taken out of every text's fonts: a text left with none draws in the platform's default face. */
function withoutFonts(nodes: readonly AssetNode[], gone: ReadonlySet<string>): AssetNode[] {
  return nodes.map((node) => {
    if (node.kind === 'text') return node.fonts?.some((name) => gone.has(name)) ? { ...node, fonts: node.fonts.filter((name) => !gone.has(name)) } : node;
    if (node.kind === 'group') return { ...node, children: withoutFonts(node.children, gone) };
    if (node.kind === 'mesh' && node.pins) {
      return { ...node, pins: Object.fromEntries(Object.entries(node.pins).map(([name, pin]) => [name, pin.children ? { ...pin, children: withoutFonts(pin.children, gone) } : pin])) };
    }
    return node;
  });
}

/**
 * Build fixed geometry and paints once. Channel-driven paths and clips are still evaluated for each pose.
 * A motion asset never takes the screen down over a font: a declared slot the host does not pass (with no embedded fallback) draws in the
 * platform's default face, and a slot the asset does not declare is ignored. Each case warns once in development, naming the slots;
 * `asset frame` and `asset preview` report the same as font-slot-fallback.
 */
export function prepareAssetDrawing(asset: DrawableMotionAsset, images: AssetImages = {}, fontSlots?: AssetFontSlots): DrawableAsset {
  const declared = asset.fontSlots ?? {};
  const unknown = fontSlots ? Object.keys(fontSlots).filter((name) => !Object.hasOwn(declared, name)) : [];
  const known = unknown.length ? Object.fromEntries(Object.entries(fontSlots!).filter(([name]) => Object.hasOwn(declared, name))) : fontSlots;
  const { fonts, missing } = resolveAssetFonts(asset, known);
  const key = `${asset.name}|${missing.join(',')}|${unknown.join(',')}`;
  if ((missing.length || unknown.length) && !warnedFontSlots.has(key) && (typeof __DEV__ === 'undefined' || __DEV__)) {
    warnedFontSlots.add(key);
    console.warn(`skia-motion: ${asset.name}${missing.length ? `: font slots ${missing.join(', ')} were not passed, so their text draws in the platform's default face` : ''}${unknown.length ? `${missing.length ? ';' : ':'} font slots ${unknown.join(', ')} are not declared by the asset and were ignored` : ''}`);
  }
  if (missing.length) asset = { ...asset, artboard: { ...asset.artboard, nodes: withoutFonts(asset.artboard.nodes, new Set(missing)) } };
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
    channels: asset.channels, artboard: { ...asset.artboard, nodes }, meshShaders: shaders, imageShaders: imageShaders(images),
    ...(fontProvider && { fontProvider }),
    ...(textBindings.size && { textBindings: [...textBindings] }),
    ...(asset.palette && { palette }),
  };
}

/** Warmed images may be different native objects. Prepare their shaders with the same geometry. */
export function rebindAssetMeshShaders(drawing: DrawableAsset, images: AssetImages): DrawableAsset {
  const shown = Object.keys(drawing.imageShaders ?? {});
  if (shown.length) drawing = { ...drawing, imageShaders: imageShaders(Object.fromEntries(shown.map((name) => [name, images[name]!]))) };
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
  const record = paintRecord(node.cacheKey === undefined ? undefined : `mesh|${node.cacheKey}`);
  const paint = record.paint;
  paint.setAlphaf(alpha);
  if (record.image !== image) {
    // Texture coordinates depend on the image drawn.
    record.image = image;
    record.vertices = undefined;
    record.shader = undefined;
  }
  if (record.shader === undefined || (shader !== undefined && record.shader !== shader)) {
    record.shader = shader ?? meshShader(image);
    paint.setShader(record.shader);
  }
  const names = node.positionChannels;
  if (names) {
    const last = record.positionChannelValues ?? (record.positionChannelValues = []);
    for (let i = 0; i < names.length; i++) {
      const value = channels[names[i]!]!;
      if (last[i] !== value) {
        record.vertices = undefined;
        last[i] = value;
      }
    }
  }
  let mesh = record.vertices;
  if (!mesh) {
    const positions = node.fixedPositions ?? node.vertices.map((vertex) => meshPosition(vertex, channels));
    const textures = node.textureCoords ?? meshTextureCoords(node, image);
    mesh = Skia.MakeVertices(VertexMode.Triangles, positions, textures, undefined, node.indices as number[]);
    if (node.fixedPositions || names) record.vertices = mesh;
  }
  canvas.drawVertices(mesh, BlendMode.SrcOver, paint);
}

function drawStroke(
  canvas: SkCanvas, path: SkPath, stroke: AssetStroke, alpha: number, feather: number, channels: Channels, palette: Palette, key?: string,
): void {
  'worklet';
  const width = Math.min(4096, read(stroke.width, channels));
  if (!(width > 0)) return;
  const start = Math.max(0, Math.min(1, read(stroke.trim?.start, channels)));
  const end = Math.max(0, Math.min(1, read(stroke.trim?.end, channels, 1)));
  if (end <= start) return;
  const trimmed = start === 0 && end === 1 ? path : Skia.Path.Trim(path, start, end, false);
  if (!trimmed) return;
  const record = paintRecord(key === undefined ? undefined : `stroke|${key}`);
  const paint = record.paint;
  paint.setAntiAlias(true);
  const color = colorOf(resolveAssetColor(stroke.color, palette));
  paint.setColor(color);
  paint.setAlphaf(alpha * color[3]!);
  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeWidth(width);
  paint.setStrokeCap(stroke.cap === 'round' ? StrokeCap.Round : stroke.cap === 'square' ? StrokeCap.Square : StrokeCap.Butt);
  paint.setStrokeJoin(stroke.join === 'round' ? StrokeJoin.Round : stroke.join === 'bevel' ? StrokeJoin.Bevel : StrokeJoin.Miter);
  if (stroke.dash) {
    const phase = read(stroke.dash.phase, channels);
    if (record.dash !== phase) {
      record.dash = phase;
      paint.setPathEffect(Skia.PathEffect.MakeDash([...stroke.dash.intervals], phase));
    }
  }
  setBlur(record, feather);
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

/** A text's ink as a row places it, measured once per text. */
function inkFor(node: AssetTextNode, text: string, fonts: SkTypefaceFontProvider | undefined): TextInk | undefined {
  'worklet';
  const key = paragraphKey(node, text);
  return cached(key === undefined ? undefined : `ink|${key}`, () => paragraphInk(makeParagraph(node, text, fonts), text, node, fonts));
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
      const inkOf = (value: string) => (value ? inkFor(styled, value, fonts) : undefined);
      return blendInk(inkOf(from), inkOf(text), rollWidthShare(from, text, read(drawn.roll.progress, channels), drawn.roll));
    }
    if (!text) return undefined;
    const paragraph = !wide && drawn.paragraph ? drawn.paragraph : makeParagraph(rollTextStyle(drawn), text, fonts);
    if (!wide) paragraphs[index] = paragraph;
    const key = paragraphKey(rollTextStyle(drawn), text);
    return cached(key === undefined ? undefined : `ink|${key}`, () => paragraphInk(paragraph, text, drawn, fonts));
  }, (index) => node.rowParts?.[index], Boolean(row.plate?.widest));
  const { moves } = rowLayout(items, row.gap, align, rtl);
  if (row.plate) {
    const box = plateBox(widest, bands, row.gap, align, rtl, row.plate.padding);
    const rect = Skia.XYWHRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    const radius = Math.min(row.plate.radius ?? Infinity, (box[2] - box[0]) / 2, (box[3] - box[1]) / 2);
    const key = node.cacheKey;
    const paint = paintRecord(key === undefined ? undefined : `plate|${key}`).paint;
    paint.setAntiAlias(true);
    paint.setColor(colorOf(resolveAssetColor(row.plate.fill, palette)));
    canvas.drawRRect(Skia.RRectXY(rect, radius, radius), paint);
    if (row.plate.stroke && row.plate.stroke.width > 0) {
      const edge = paintRecord(key === undefined ? undefined : `edge|${key}`).paint;
      edge.setAntiAlias(true);
      edge.setStyle(PaintStyle.Stroke);
      edge.setStrokeWidth(row.plate.stroke.width);
      edge.setColor(colorOf(resolveAssetColor(row.plate.stroke.color, palette)));
      canvas.drawRRect(Skia.RRectXY(rect, radius, radius), edge);
    }
  }
  return { moves, paragraphs };
}

function drawNodes(
  canvas: SkCanvas, nodes: readonly DrawableNode[], channels: Channels, images: AssetImages, shaders: DrawShaders,
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
      if (node.clip) canvas.clipPath(node.preparedClip ?? makePath(node.clip, channels, node.cacheKey), ClipOp.Intersect, true);
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
      if (image && alpha) drawMesh(canvas, node, channels, image, alpha, shaders.mesh[node.image]);
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
      const path = node.preparedPath ?? makePath(node.commands, channels, node.cacheKey);
      if (node.fill) canvas.drawPath(path, node.preparedPaint ?? makePaint(node, alpha, channels, palette, node.cacheKey));
      if (node.stroke) drawStroke(canvas, path, node.stroke, alpha, Math.min(MAX_FEATHER, read(node.feather, channels)), channels, palette, node.cacheKey);
      continue;
    }
    if (node.kind === 'image') {
      const image = images[node.image];
      const width = read(node.width, channels);
      const height = read(node.height, channels);
      if (!image || width <= 0 || height <= 0) continue;
      const imageWidth = image.width();
      const imageHeight = image.height();
      // The prepared shader only for the image it was made from: a host can pass other images to drawAsset.
      const prepared = shaders.image[node.image];
      const shader = prepared && prepared.image === image ? prepared.shader : imageShader(image);
      const key = node.cacheKey;
      // One paint per image node, reset each frame: a picture records a copy of the paint it draws with.
      const filled = cached(key === undefined ? undefined : `paint|${key}`, () => {
        const paint = Skia.Paint();
        paint.setAntiAlias(true);
        return paint;
      });
      filled.setAlphaf(alpha);
      filled.setShader(shader);
      canvas.save();
      canvas.translate(read(node.x, channels), read(node.y, channels));
      canvas.scale(width / imageWidth, height / imageHeight);
      canvas.drawRect(rectOf(key, 0, 0, imageWidth, imageHeight).rect, filled);
      canvas.restore();
      continue;
    }
    const paint = node.preparedPaint ?? makePaint(node, alpha, channels, palette, node.cacheKey);
    const w = read(node.width, channels);
    const h = read(node.height, channels);
    if (w <= 0 || h <= 0) continue;
    if (node.kind === 'ellipse') canvas.drawOval(rectOf(node.cacheKey, read(node.x, channels), read(node.y, channels), w, h).rect, paint);
    else {
      const radius = Math.min(w / 2, h / 2, Math.max(0, read(node.radius, channels)));
      const box = rectOf(node.cacheKey, read(node.x, channels), read(node.y, channels), w, h, radius);
      if (box.rrect) canvas.drawRRect(box.rrect, paint);
      else canvas.drawRect(box.rect, paint);
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
  drawNodes(canvas, board.nodes, { ...asset.channels, ...pose }, images, { mesh: asset.meshShaders ?? {}, image: asset.imageShaders ?? {} },
    values, asset.fontProvider, asset.palette ?? {}, layout);
  canvas.restore();
}
