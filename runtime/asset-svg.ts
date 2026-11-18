import { MAX_FEATHER, type AssetNode, type MotionAsset, type PathCommand } from './asset';
import { anchorOffset, layoutAsset } from './asset-layout';
import { meshPinPosition, meshPosition, type MeshVertex, type MeshNode } from './asset-mesh';

const opacity = (value: number) => Math.max(0, Math.min(1, value));
type Point = ReturnType<typeof meshPosition>;

function triangleMatrix(source: readonly MeshVertex[], target: readonly Point[]): number[] {
  const [[, , u0, v0], [, , u1, v1], [, , u2, v2]] = source as readonly [MeshVertex, MeshVertex, MeshVertex];
  const [p0, p1, p2] = target as readonly [Point, Point, Point];
  const du1 = u1 - u0;
  const dv1 = v1 - v0;
  const du2 = u2 - u0;
  const dv2 = v2 - v0;
  const det = du1 * dv2 - dv1 * du2;
  const a = ((p1.x - p0.x) * dv2 - (p2.x - p0.x) * dv1) / det;
  const b = ((p1.y - p0.y) * dv2 - (p2.y - p0.y) * dv1) / det;
  const c = ((p2.x - p0.x) * du1 - (p1.x - p0.x) * du2) / det;
  const d = ((p2.y - p0.y) * du1 - (p1.y - p0.y) * du2) / det;
  return [a, b, c, d, p0.x - a * u0 - c * v0, p0.y - b * u0 - d * v0];
}

function meshSVG(node: MeshNode, channels: Record<string, number>, alpha: number, id: string, defs: string[]): string {
  if (!alpha) return '';
  const positions = node.vertices.map((vertex) => meshPosition(vertex, channels));
  const triangles = [];
  for (let i = 0; i < node.indices.length; i += 3) {
    const indices = node.indices.slice(i, i + 3);
    const target = indices.map((index) => positions[index]!);
    const matrix = triangleMatrix(indices.map((index) => node.vertices[index]!), target);
    const clip = `triangle-${defs.length}`;
    defs.push(`<clipPath id="${clip}"><polygon points="${target.map(({ x, y }) => `${x},${y}`).join(' ')}"/></clipPath>`);
    triangles.push(`<g clip-path="url(#${clip})"><use href="#${id}" transform="matrix(${matrix.join(' ')})"/></g>`);
  }
  return `<g opacity="${alpha}">${triangles.join('')}</g>`;
}

/** Draw a seekable CLI preview from the same validated scene and pose used by the mobile renderer. */
export function assetSVG(asset: MotionAsset, channels: Record<string, number>, size = { width: asset.artboard.width, height: asset.artboard.height }): string {
  const { artboard } = asset;
  const { insetX, insetY } = layoutAsset(artboard, size.width, size.height);
  const defs: string[] = [];
  const meshImages = new Map<string, string>();
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
    if (node.kind === 'mesh') {
      const uri = asset.images![node.image]!;
      let id = meshImages.get(uri);
      if (!id && alpha) {
        id = `mesh-image-${defs.length}`;
        defs.push(`<image id="${id}" href="${uri}" width="1" height="1" preserveAspectRatio="none"/>`);
        meshImages.set(uri, id);
      }
      const pins = Object.values(node.pins ?? {}).map((pin) => {
        if (!pin.children?.length) return '';
        const { x, y } = meshPinPosition(node, pin, channels);
        return `<g transform="translate(${x} ${y})">${pin.children.map((child) => draw(child)).join('')}</g>`;
      }).join('');
      return (id ? meshSVG(node, channels, alpha, id, defs) : '') + pins;
    }
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
