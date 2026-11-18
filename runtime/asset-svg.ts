import { MAX_FEATHER, type AssetNode, type MotionAsset, type PathCommand } from './asset';
import { anchorOffset, layoutAsset } from './asset-layout';

const opacity = (value: number) => Math.max(0, Math.min(1, value));

/** Draw a seekable CLI preview from the same validated scene and pose used by the mobile renderer. */
export function assetSVG(asset: MotionAsset, channels: Record<string, number>, size = { width: asset.artboard.width, height: asset.artboard.height }): string {
  const { artboard } = asset;
  const { insetX, insetY } = layoutAsset(artboard, size.width, size.height);
  const defs: string[] = [];
  const read = (value: number | string | undefined, fallback = 0) =>
    typeof value === 'string' ? channels[value]! : value ?? fallback;
  const resolvePath = (commands: readonly PathCommand[]) =>
    commands.map(([op, ...coords]) => [op, ...coords.map((coord) => read(coord))] as const);
  const pathData = (commands: ReturnType<typeof resolvePath>) =>
    commands.map((command) => command.join(' ')).join(' ');
  const draw = (node: AssetNode, paddingX = 0, paddingY = 0): string => {
    if (node.kind === 'group') {
      let clip = '';
      if (node.clip) {
        const id = `clip-${defs.length}`;
        const path = pathData(resolvePath(node.clip));
        defs.push(`<clipPath id="${id}"><path d="${path}"/></clipPath>`);
        clip = ` clip-path="url(#${id})"`;
      }
      const offset = anchorOffset(node.anchor, paddingX, paddingY);
      const transform = `translate(${read(node.x) + offset.x} ${read(node.y) + offset.y}) rotate(${read(node.rotation)}) scale(${read(node.scaleX, 1)} ${read(node.scaleY, 1)})`;
      return `<g transform="${transform}"${clip}>${node.children.map((child) => draw(child)).join('')}</g>`;
    }
    const alpha = opacity(read(node.opacity, 1));
    if (!alpha) return '';
    if (node.kind === 'image') {
      const width = read(node.width);
      const height = read(node.height);
      if (width <= 0 || height <= 0) return '';
      return `<image href="${asset.images![node.image]}" x="${read(node.x)}" y="${read(node.y)}" width="${width}" height="${height}" opacity="${alpha}" preserveAspectRatio="none"/>`;
    }
    let fill = node.fill;
    if (typeof fill !== 'string') {
      const id = `light-${defs.length}`;
      const center = `cx="${read(fill.x)}" cy="${read(fill.y)}" r="${Math.max(0.001, read(fill.radius))}"`;
      const stops = fill.colors.map((color, i) => {
        const alpha = color.length === 9 ? parseInt(color.slice(7), 16) / 255 : 1;
        return `<stop offset="${i}" stop-color="${color.slice(0, 7)}" stop-opacity="${alpha}"/>`;
      }).join('');
      defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" ${center}>${stops}</radialGradient>`);
      fill = `url(#${id})`;
    }
    const style = `fill="${fill}" opacity="${alpha}"`;
    const feather = Math.min(MAX_FEATHER, read(node.feather));
    const edge = (x: number, y: number, width: number, height: number): string => {
      if (feather <= 0) return '';
      const id = `feather-${defs.length}`;
      const pad = Math.ceil(4 * feather);
      defs.push(`<filter id="${id}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB" x="${x - pad}" y="${y - pad}" width="${width + 2 * pad}" height="${height + 2 * pad}"><feGaussianBlur stdDeviation="${feather}"/></filter>`);
      return ` filter="url(#${id})"`;
    };
    if (node.kind === 'path') {
      const commands = resolvePath(node.commands);
      let filter = '';
      if (feather > 0) {
        // Bézier curves stay within their control points, so these bounds include the entire shape.
        const coordinates = commands.flatMap(([, ...points]) => points);
        const xs = coordinates.filter((_, i) => i % 2 === 0);
        const ys = coordinates.filter((_, i) => i % 2 === 1);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        filter = edge(x, y, Math.max(...xs) - x, Math.max(...ys) - y);
      }
      return `<path d="${pathData(commands)}" ${style}${filter}/>`;
    }
    const x = read(node.x);
    const y = read(node.y);
    const w = read(node.width);
    const h = read(node.height);
    if (w <= 0 || h <= 0) return '';
    const filter = edge(x, y, w, h);
    if (node.kind === 'ellipse') return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${style}${filter}/>`;
    const radius = Math.min(w / 2, h / 2, Math.max(0, read(node.radius)));
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" ${style}${filter}/>`;
  };
  const { width, height, nodes } = artboard;
  let shapes = nodes.map((node) => draw(node, insetX, insetY)).join('');
  if ((insetX || insetY) && !nodes.some((node) => node.kind === 'group' && node.anchor)) {
    defs.push(`<clipPath id="artboard"><rect width="${width}" height="${height}"/></clipPath>`);
    shapes = `<g clip-path="url(#artboard)">${shapes}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="${-insetX} ${-insetY} ${width + 2 * insetX} ${height + 2 * insetY}"><defs>${defs.join('')}</defs>${shapes}</svg>\n`;
}
