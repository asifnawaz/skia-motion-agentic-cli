import { BlurStyle, ClipOp, FilterMode, MipmapMode, Skia, TileMode, type SkCanvas, type SkData, type SkImage, type SkPaint, type SkPath } from 'react-native-skia';
import { MAX_FEATHER, usedAssetImages, type AssetNode, type MotionAsset, type PathCommand } from './asset';
import { anchorOffset, layoutAsset } from './asset-layout';

type Channels = Readonly<Record<string, number>>;
type DrawableNode =
  | (Omit<Extract<AssetNode, { kind: 'group' }>, 'children'> & {
      children: readonly DrawableNode[];
      preparedClip?: SkPath;
    })
  | (DrawableShape & { preparedPath?: SkPath; preparedPaint?: SkPaint });

type DrawableShape = Exclude<AssetNode, { kind: 'group' }>;

export type DrawableAsset = Pick<MotionAsset, 'channels'> & {
  artboard: Omit<MotionAsset['artboard'], 'nodes'> & { nodes: readonly DrawableNode[] };
};
export type AssetImages = Readonly<Record<string, SkImage>>;

/** Decode on the JS thread once per loaded file. Only the native images enter the UI worklet. */
export function decodeAssetImages(asset: MotionAsset): AssetImages {
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
    const uri = embedded[name]!;
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

function makePaint(node: DrawableShape, alpha: number, channels: Channels): SkPaint {
  'worklet';
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  if (node.kind === 'image') {
    paint.setAlphaf(alpha);
    return paint;
  }
  const feather = Math.min(MAX_FEATHER, read(node.feather, channels));
  if (feather > 0) paint.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, feather, true));
  if (typeof node.fill === 'string') {
    const color = Skia.Color(node.fill);
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

function preparePaint(node: DrawableShape): SkPaint | undefined {
  if (typeof node.opacity === 'string' || node.opacity === 0) return undefined;
  if (node.kind !== 'image') {
    if (typeof node.feather === 'string') return undefined;
    const light = node.fill;
    if (typeof light !== 'string' && [light.x, light.y, light.radius].some((value) => typeof value === 'string')) {
      return undefined;
    }
  }
  return makePaint(node, node.opacity ?? 1, {});
}

function prepareNode(node: AssetNode): DrawableNode {
  const commands = node.kind === 'group' ? node.clip : node.kind === 'path' ? node.commands : undefined;
  const prepared = commands?.every(([, ...coordinates]) => coordinates.every((value) => typeof value === 'number'))
    ? makePath(commands, {})
    : undefined;
  if (node.kind === 'group') {
    const { points: _points, ...drawing } = node;
    return { ...drawing, preparedClip: prepared, children: node.children.map(prepareNode) };
  }
  return { ...node, preparedPath: prepared, preparedPaint: preparePaint(node) };
}

/** Build fixed geometry and paints once. Channel-driven paths and clips are still evaluated for each pose. */
export function prepareAssetDrawing(asset: MotionAsset): DrawableAsset {
  return { channels: asset.channels, artboard: { ...asset.artboard, nodes: asset.artboard.nodes.map(prepareNode) } };
}

function drawNodes(canvas: SkCanvas, nodes: readonly DrawableNode[], channels: Channels, images: AssetImages, insetX = 0, insetY = 0): void {
  'worklet';
  for (const node of nodes) {
    if (node.kind === 'group') {
      const offset = anchorOffset(node.anchor, insetX, insetY);
      canvas.save();
      canvas.translate(read(node.x, channels) + offset.x, read(node.y, channels) + offset.y);
      canvas.rotate(read(node.rotation, channels), 0, 0);
      canvas.scale(read(node.scaleX, channels, 1), read(node.scaleY, channels, 1));
      if (node.clip) canvas.clipPath(node.preparedClip ?? makePath(node.clip, channels), ClipOp.Intersect, true);
      drawNodes(canvas, node.children, channels, images);
      canvas.restore();
      continue;
    }
    const alpha = Math.min(1, Math.max(0, read(node.opacity, channels, 1)));
    if (!alpha) continue;
    const paint = node.preparedPaint ?? makePaint(node, alpha, channels);
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
    if (node.kind === 'path') {
      canvas.drawPath(node.preparedPath ?? makePath(node.commands, channels), paint);
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
export function drawAsset(canvas: SkCanvas, asset: DrawableAsset, pose: Channels, width: number, height: number, images: AssetImages = {}): void {
  'worklet';
  if (width <= 0 || height <= 0) return;
  const board = asset.artboard;
  const { scale, insetX, insetY } = layoutAsset(board, width, height);
  const anchored = board.nodes.some((node) => node.kind === 'group' && node.anchor);
  canvas.save();
  canvas.translate(insetX * scale, insetY * scale);
  canvas.scale(scale, scale);
  const bounds = anchored
    ? Skia.XYWHRect(-insetX, -insetY, board.width + 2 * insetX, board.height + 2 * insetY)
    : Skia.XYWHRect(0, 0, board.width, board.height);
  canvas.clipRect(bounds, ClipOp.Intersect, true);
  drawNodes(canvas, board.nodes, { ...asset.channels, ...pose }, images, insetX, insetY);
  canvas.restore();
}
