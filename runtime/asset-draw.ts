import {
  BlendMode, BlurStyle, ClipOp, FilterMode, MipmapMode, PaintStyle, Skia, StrokeCap, StrokeJoin, TextAlign, TextDirection, TileMode, VertexMode,
  type SkCanvas, type SkData, type SkImage, type SkPaint, type SkParagraph, type SkPath, type SkShader, type SkTypeface, type SkTypefaceFontProvider,
} from 'react-native-skia';
import { MAX_FEATHER, resolveAssetColor, usedAssetImages, type AssetNode, type AssetStroke, type AssetTextNode, type MotionAsset, type PathCommand } from './asset';
import { fitAsset, fittedAnchorOffset, type AssetLayoutOptions } from './asset-layout';
import { meshPinPosition, meshPosition, type MeshNode, type MeshPin } from './asset-mesh';

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
export type AssetMeshShaders = Readonly<Record<string, SkShader>>;

/** Decode on the JS thread once per loaded file. Only the native images enter the UI worklet. */
export function decodeAssetImages(asset: MotionAsset, slots: AssetImages = {}): AssetImages {
  for (const name of Object.keys(slots)) {
    if (!asset.imageSlots || !Object.hasOwn(asset.imageSlots, name)) throw new Error(`Unknown motion image slot "${name}"`);
  }
  if (!asset.images) return {};
  // Skia v3 renamed this factory after 3.0. Keep both names usable at the peer dependency floor.
  const factory = Skia.Image as {
    MakeFromEncoded?: (data: SkData) => SkImage | null;
    MakeImageFromEncoded?: (data: SkData) => SkImage | null;
  };
  const byUri = new Map<string, SkImage>();
  const embedded = asset.images;
  const used = usedAssetImages(asset.artboard.nodes);
  return Object.fromEntries(Array.from(used, (name) => {
    if (Object.hasOwn(slots, name)) return [name, slots[name]!];
    const uri = embedded[asset.imageSlots?.[name] ?? name]!;
    const previous = byUri.get(uri);
    if (previous) return [name, previous];
    const data = Skia.Data.fromBase64(uri.slice(uri.indexOf(',') + 1));
    const image = factory.MakeFromEncoded ? factory.MakeFromEncoded(data) : factory.MakeImageFromEncoded?.(data);
    if (!image) throw new Error(`images.${name}: could not decode the embedded image`);
    byUri.set(uri, image);
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

function makeParagraph(node: AssetTextNode, text: string, provider?: SkTypefaceFontProvider): SkParagraph {
  'worklet';
  const builder = Skia.ParagraphBuilder.Make({
    textDirection: node.direction === 'rtl' ? TextDirection.RTL : TextDirection.LTR,
    textAlign: node.align === 'center' ? TextAlign.Center : node.align === 'end' ? TextAlign.End : TextAlign.Start,
    maxLines: node.maxLines ?? 1,
    ellipsis: '…',
  }, node.fonts?.length ? provider : undefined);
  builder.pushStyle({
    color: Skia.Color(node.fill), fontSize: node.fontSize,
    ...(node.fonts?.length ? { fontFamilies: [...node.fonts] } : {}),
  });
  builder.addText(text);
  const paragraph = builder.build();
  paragraph.layout(node.width);
  return paragraph;
}

function prepareNode(
  node: AssetNode, images: AssetImages, shaders: Record<string, SkShader>, shadersByImage: Map<SkImage, SkShader>,
  provider: SkTypefaceFontProvider | undefined, textBindings: Set<string>, palette: Palette,
): DrawableNode {
  if (node.kind === 'text') {
    if (typeof node.text === 'string') return { ...node, paragraph: makeParagraph(node, node.text, provider) };
    textBindings.add(node.text.value);
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
export function prepareAssetDrawing(asset: MotionAsset, images: AssetImages = {}): DrawableAsset {
  const shaders: Record<string, SkShader> = {};
  const shadersByImage = new Map<SkImage, SkShader>();
  let fontProvider: SkTypefaceFontProvider | undefined;
  for (const [name, uri] of Object.entries(asset.fonts ?? {})) {
    fontProvider ??= Skia.TypefaceFontProvider.Make();
    const data = Skia.Data.fromBase64(uri.slice(uri.indexOf(',') + 1));
    // Match the renamed factory while retaining the Skia 3.0 peer floor.
    const factory = Skia.Typeface as {
      MakeFromData?: (data: SkData) => SkTypeface | null;
      MakeFreeTypeFaceFromData?: (data: SkData) => SkTypeface | null;
    };
    const typeface = factory.MakeFromData ? factory.MakeFromData(data) : factory.MakeFreeTypeFaceFromData?.(data);
    if (!typeface) throw new Error(`fonts.${name}: Skia could not decode the font`);
    fontProvider.registerFont(typeface, name);
  }
  const textBindings = new Set<string>();
  const palette = asset.palette ?? {};
  const nodes = asset.artboard.nodes.map((node) => prepareNode(node, images, shaders, shadersByImage, fontProvider, textBindings, palette));
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
      drawNodes(canvas, node.children, channels, images, shaders, values, fonts, palette);
      canvas.restore();
      continue;
    }
    if (node.kind === 'text') {
      const content = typeof node.text === 'string' ? node.text : values[node.text.value] ?? '';
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
