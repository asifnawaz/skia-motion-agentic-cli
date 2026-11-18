import { anchorOffset, layoutAsset } from './asset-layout';
import type { AssetAttachment, AssetNode, MotionAsset } from './asset';
import { meshPinPosition } from './asset-mesh';

export type AssetViewport = { width: number; height: number };
export type ArtboardPoint = { x: number; y: number };
type TransformPoint = (x: number, y: number) => ArtboardPoint;

export function hasAssetPoints(nodes: readonly AssetNode[]): boolean {
  return nodes.some((node) =>
    (node.kind === 'group' && (Boolean(node.points) || hasAssetPoints(node.children))) ||
    (node.kind === 'mesh' && Object.keys(node.pins ?? {}).length > 0));
}

export function assetPoints(
  asset: MotionAsset, channels: Record<string, number>, viewport: AssetViewport = asset.artboard,
): Record<string, ArtboardPoint> | undefined {
  const { insetX, insetY } = layoutAsset(asset.artboard, viewport.width, viewport.height);
  let points: Record<string, ArtboardPoint> | undefined;
  const read = (value: number | string | undefined, fallback = 0) =>
    typeof value === 'string' ? channels[value]! : value ?? fallback;
  const visit = (nodes: readonly AssetNode[], parent: TransformPoint) => {
    for (const node of nodes) {
      if (node.kind === 'mesh' && node.pins) {
        points ??= {};
        for (const [name, pin] of Object.entries(node.pins)) {
          const { x, y } = meshPinPosition(node, pin, channels);
          points[name] = parent(x, y);
          if (pin.children) visit(pin.children, (px, py) => parent(x + px, y + py));
        }
      }
      if (node.kind !== 'group') continue;
      const offset = anchorOffset(node.anchor, insetX, insetY);
      const x = read(node.x) + offset.x;
      const y = read(node.y) + offset.y;
      const angle = read(node.rotation) * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const sx = read(node.scaleX, 1);
      const sy = read(node.scaleY, 1);
      // Same order as the renderer: a local point scales, rotates, then translates.
      const transform: TransformPoint = (px, py) =>
        parent(x + cos * px * sx - sin * py * sy, y + sin * px * sx + cos * py * sy);
      if (node.points) {
        points ??= {};
        for (const [name, point] of Object.entries(node.points)) points[name] = transform(read(point.x), read(point.y));
      }
      visit(node.children, transform);
    }
  };
  visit(asset.artboard.nodes, (x, y) => ({ x, y }));
  return points;
}

export function measureAttachments(
  attachments: readonly AssetAttachment[],
  rows: readonly { t_ms: number; points?: Record<string, ArtboardPoint> }[],
) {
  return attachments.map((attachment) => {
    let distance = -1;
    let t_ms = 0;
    for (const row of rows) {
      const from = row.points![attachment.from]!;
      const to = row.points![attachment.to]!;
      const gap = Math.hypot(to.x - from.x, to.y - from.y);
      if (gap <= distance) continue;
      distance = gap;
      t_ms = row.t_ms;
    }
    return { ...attachment, distance, t_ms };
  });
}
