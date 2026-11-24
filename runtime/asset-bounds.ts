import { anchorOffset, layoutAsset } from './asset-layout';
import type { AssetNode, AssetTextNode, MotionAsset, PathCommand, Scalar } from './asset';
import type { Literal } from '../templates/motion/machine';
import { meshPinPosition, meshPosition } from './asset-mesh';
import type { AssetViewport } from './asset-attachments';
import { digitText, rollFrame, rollWidthShare } from './asset-roll';
import { blendInk, plateBox, rowItems, rowLayout, type RowChild, type TextInk } from './asset-ink';

/** An axis-aligned box in artboard points: left, top, right, bottom. */
export type Box = readonly [x0: number, y0: number, x1: number, y1: number];
/** Where a text's lines sit inside its node, in the node's own units, and whether it was laid out or is the declared box. */
export type TextExtent = {
  left: number; top: number; width: number; height: number; source: 'layout' | 'declared';
  /** The optical band (cap or x-height above the baseline) from top to bottom, when the text was laid out. */
  band?: readonly [number, number];
};
export type InkEntry = {
  /** The node's place in the artboard, in the form `artboard.nodes[2].children[0]`. */
  where: string;
  kind: AssetNode['kind'];
  /** Undefined when the node draws nothing at this time (zero size, zero opacity or nothing visible inside a group). */
  box?: Box;
  /** A mesh's own surface, without the nodes on its pins (which `box` takes in, and which have entries of their own). */
  own?: Box;
  /** Where the node sits, in artboard points, even while it is hidden or scaled to nothing: the transformed middle of its own extent. */
  centre?: { x: number; y: number };
  /** A circle (an ellipse with equal radii under its transform, feather included): its ink is judged by the circle, not the box corners. */
  circle?: { x: number; y: number; r: number };
  /** The shape's own opacity; groups and text are 1. */
  alpha: number;
  text?: { value: string; source: TextExtent['source']; band?: readonly [number, number] };
};
type Transform = (x: number, y: number) => { x: number; y: number };

/** Below this opacity a shape is treated as not drawn. */
export const INK_ALPHA = 0.05;

/**
 * The text a node shows at this time, or undefined when it is empty. A rolling number shows, in each place, the digit that holds most of
 * the column (the current one until half way, then the next), with its prefix and suffix; a blank leading place shows nothing.
 */
export function shownText(
  node: AssetTextNode, values: Readonly<Record<string, Literal>>, asset: MotionAsset, channels: Readonly<Record<string, number>> = {},
): string | undefined {
  const bound = (name: string) => {
    const value = values[name] ?? (asset.machine.values?.[name] as { default?: Literal } | undefined)?.default;
    return typeof value === 'string' ? value : '';
  };
  let value = typeof node.text === 'string' ? node.text : bound(node.text.value);
  if (node.roll) {
    const progress = channels[node.roll.progress] ?? asset.channels[node.roll.progress] ?? 0;
    const frame = rollFrame(bound(node.roll.from), value, progress, node.roll);
    // At either end the roll shows exactly the string the host set, zero padding and all.
    if (progress <= 0) value = bound(node.roll.from);
    else if (progress < 1) {
      value = frame
        ? frame.prefix + frame.places.map(({ current, next, turn }) => digitText(turn >= 0.5 ? next : current, frame.zero)).join('') + frame.suffix
        : progress < 0.5 ? bound(node.roll.from) : value;
    }
  }
  return value || undefined;
}

/** The box a text node declares: its width and one line of 1.2 times the font size per allowed line. */
export function declaredText(node: AssetTextNode): TextExtent {
  return { left: 0, top: 0, width: node.width, height: node.fontSize * 1.2 * (node.maxLines ?? 1), source: 'declared' };
}

function union(a: Box | undefined, b: Box | undefined): Box | undefined {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function transformed(local: Box, transform: Transform): Box | undefined {
  const [x0, y0, x1, y1] = local;
  if (!(x1 - x0 > 0.01) || !(y1 - y0 > 0.01)) return undefined;
  const corners = [transform(x0, y0), transform(x1, y0), transform(x0, y1), transform(x1, y1)];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const box: Box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return box[2] - box[0] > 0.01 && box[3] - box[1] > 0.01 ? box : undefined;
}

function pathPoints(commands: readonly PathCommand[], read: (value: Scalar | undefined) => number) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const command of commands) {
    for (let i = 1; i + 1 < command.length; i += 2) {
      xs.push(read(command[i] as Scalar));
      ys.push(read(command[i + 1] as Scalar));
    }
  }
  return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as Box : undefined;
}

/**
 * Every node's drawn box at one pose, in artboard points, with the same transform order as the renderer (a local point scales, rotates,
 * then translates; anchors follow the viewport). A blur (feather) widens a shape by one feather, a stroke by half its width. A group's box is
 * the union of what its children draw. Text takes the extent `textExtent` gives it (the laid-out lines, or the declared box).
 */
export function assetInkBoxes(
  asset: MotionAsset, channels: Readonly<Record<string, number>>, values: Readonly<Record<string, Literal>>,
  textExtent: (node: AssetTextNode, where: string, text: string) => TextExtent,
  viewport: AssetViewport = asset.artboard,
  /** The drawn part of an image as fractions of its box (left, top, right, bottom), from its alpha; the whole box when unknown. */
  imageInk: (image: string) => Box | undefined = () => undefined,
): Map<string, InkEntry> {
  const { insetX, insetY } = layoutAsset(asset.artboard, viewport.width, viewport.height);
  const read = (value: Scalar | undefined, fallback = 0) => typeof value === 'string' ? channels[value]! : value ?? fallback;
  const entries = new Map<string, InkEntry>();
  const clipped = (box: Box | undefined, clip: Box | undefined): Box | undefined => {
    if (!box || !clip) return box;
    const out: Box = [Math.max(box[0], clip[0]), Math.max(box[1], clip[1]), Math.min(box[2], clip[2]), Math.min(box[3], clip[3])];
    return out[2] - out[0] > 0.01 && out[3] - out[1] > 0.01 ? out : undefined;
  };
  // A row moves each child by its layout (asset-ink.ts), from the same text ink and image parts the app measures.
  // A bound text in a row with a widest sample is centred on that sample's band (asset-ink.ts rowItems), so it is judged on it too.
  type RowPlacing = { moves: [number, number][]; bands: (readonly [number, number] | undefined)[] };
  const rowMoves = (node: Extract<AssetNode, { kind: 'group' }>, where: string, local: Transform, clip?: Box): RowPlacing => {
    const row = node.row!;
    const rowBands: (readonly [number, number] | undefined)[] = [];
    const align = row.align ?? 'start';
    const rtl = row.direction === 'rtl';
    const { items, widest, bands } = rowItems(node.children as unknown as readonly RowChild[], read, (child, index, wide) => {
      const textNode = node.children[index] as AssetTextNode;
      const inkOf = (text: string | undefined): TextInk | undefined => {
        if (!text) return undefined;
        const extent = textExtent(textNode, `${where}.children[${index}]`, text);
        return { box: [extent.left, extent.top, extent.left + extent.width, extent.top + extent.height], band: extent.band ?? [extent.top, extent.top + extent.height] };
      };
      if (wide) {
        const measured = inkOf(row.plate!.widest!);
        rowBands[index] = measured?.band;
        return measured;
      }
      if (textNode.roll && typeof textNode.text !== 'string') {
        const bound = (name: string) => {
          const value = values[name] ?? (asset.machine.values?.[name] as { default?: Literal } | undefined)?.default;
          return typeof value === 'string' ? value : undefined;
        };
        const from = bound(textNode.roll.from);
        const to = bound(textNode.text.value);
        const share = from !== undefined && to !== undefined ? rollWidthShare(from, to, read(textNode.roll.progress), textNode.roll) : read(textNode.roll.progress);
        return blendInk(inkOf(from), inkOf(to), share);
      }
      return inkOf(shownText(textNode, values, asset, channels));
    }, (index) => {
      const child = node.children[index]!;
      return child.kind === 'image' && !asset.imageSlots?.[child.image] ? asset.imageInk?.[child.image] as Box | undefined ?? imageInk(child.image) : undefined;
    }, Boolean(row.plate?.widest));
    const { moves } = rowLayout(items, row.gap, align, rtl);
    if (row.plate) {
      const plate = plateBox(widest, bands, row.gap, align, rtl, row.plate.padding);
      const box = clipped(transformed(plate, local), clip);
      entries.set(`${where}.children[plate]`, { where: `${where}.children[plate]`, kind: 'roundRect', box, alpha: 1, centre: local((plate[0] + plate[2]) / 2, (plate[1] + plate[3]) / 2) });
    }
    return { moves, bands: rowBands };
  };
  const visit = (nodes: readonly AssetNode[], parent: string, outer: Transform, clip?: Box, placing?: RowPlacing): Box | undefined => {
    const moves = placing?.moves;
    let all: Box | undefined;
    nodes.forEach((node, index) => {
      const where = `${parent}[${index}]`;
      const move = moves?.[index];
      const transform: Transform = move ? (px, py) => outer(px + move[0], py + move[1]) : outer;
      let box: Box | undefined;
      let centre: InkEntry['centre'];
      let circle: InkEntry['circle'];
      let alpha = 1;
      let text: InkEntry['text'];
      let own: Box | undefined;
      if (node.kind === 'group') {
        const offset = anchorOffset(node.anchor, insetX, insetY);
        const x = read(node.x) + offset.x;
        const y = read(node.y) + offset.y;
        const angle = read(node.rotation) * Math.PI / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const sx = read(node.scaleX, 1);
        const sy = read(node.scaleY, 1);
        const local: Transform = (px, py) => transform(x + cos * px * sx - sin * py * sy, y + sin * px * sx + cos * py * sy);
        let inner = clip;
        if (node.clip) {
          const bounds = pathPoints(node.clip, read);
          const area = bounds && transformed(bounds, local);
          inner = area ? clipped(area, clip) ?? [0, 0, 0, 0] : [0, 0, 0, 0];
        }
        const placing = node.row ? rowMoves(node, where, local, inner) : undefined;
        box = union(node.row?.plate ? entries.get(`${where}.children[plate]`)?.box : undefined, visit(node.children, `${where}.children`, local, inner, placing));
      } else if (node.kind === 'text') {
        const value = shownText(node, values, asset, channels);
        if (value) {
          const extent = textExtent(node, where, value);
          const x = read(node.x) + extent.left;
          const y = read(node.y) + extent.top;
          box = clipped(transformed([x, y, x + extent.width, y + extent.height], transform), clip);
          centre = transform(x + extent.width / 2, y + extent.height / 2);
          const measured = placing?.bands[index] ?? extent.band;
          const band = measured && [transform(x, read(node.y) + measured[0]).y, transform(x, read(node.y) + measured[1]).y] as const;
          text = { value, source: extent.source, ...(band && { band }) };
        }
      } else if (node.kind === 'mesh') {
        alpha = read(node.opacity, 1);
        const points = node.vertices.map((vertex) => meshPosition(vertex, channels));
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        if (alpha >= INK_ALPHA && points.length) box = clipped(transformed([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], transform), clip);
        own = box ?? [0, 0, 0, 0];
        for (const [name, pin] of Object.entries(node.pins ?? {})) {
          if (!pin.children) continue;
          const at = meshPinPosition(node, pin, channels);
          box = union(box, visit(pin.children, `${where}.pins.${name}.children`, (px, py) => transform(at.x + px, at.y + py), clip));
        }
      } else {
        alpha = read(node.opacity, 1);
        const feather = 'feather' in node ? Math.max(0, read(node.feather)) : 0;
        let local: Box | undefined;
        if (node.kind === 'path') {
          local = pathPoints(node.commands, read);
          const stroke = node.stroke ? Math.max(0, read(node.stroke.width)) / 2 : 0;
          if (local) local = [local[0] - stroke, local[1] - stroke, local[2] + stroke, local[3] + stroke];
        } else {
          const x = read(node.x);
          const y = read(node.y);
          const w = read(node.width);
          const h = read(node.height);
          const part = node.kind === 'image' ? imageInk(node.image) : undefined;
          local = part ? [x + part[0] * w, y + part[1] * h, x + part[2] * w, y + part[3] * h] : [x, y, x + w, y + h];
        }
        if (local && feather) local = [local[0] - feather, local[1] - feather, local[2] + feather, local[3] + feather];
        if (local) centre = transform((local[0] + local[2]) / 2, (local[1] + local[3]) / 2);
        if (local && alpha >= INK_ALPHA) box = clipped(transformed(local, transform), clip);
        if (node.kind === 'ellipse' && local && centre && box) {
          const across = transform(local[2], (local[1] + local[3]) / 2);
          const down = transform((local[0] + local[2]) / 2, local[3]);
          const rx = Math.hypot(across.x - centre.x, across.y - centre.y);
          const ry = Math.hypot(down.x - centre.x, down.y - centre.y);
          if (Math.abs(rx - ry) <= 0.5) {
            const r = (rx + ry) / 2;
            circle = { x: centre.x, y: centre.y, r };
            box = clipped([centre.x - r, centre.y - r, centre.x + r, centre.y + r], clip);
            if (!box) circle = undefined;
          }
        }
      }
      entries.set(where, { where, kind: node.kind, box, alpha, ...(own && { own }), ...(centre && { centre }), ...(circle && { circle }), ...(text && { text }) });
      all = union(all, box);
    });
    return all;
  };
  visit(asset.artboard.nodes, 'artboard.nodes', (x, y) => ({ x, y }));
  return entries;
}
