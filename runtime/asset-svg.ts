import { MAX_FEATHER, resolveAssetColor, type AssetNode, type AssetStroke, type MotionAsset, type PathCommand } from './asset';
import { anchorOffset, layoutAsset } from './asset-layout';
import { meshPinPosition, meshPosition, type MeshVertex, type MeshNode } from './asset-mesh';
import { digitText, restText, rollFrame } from './asset-roll';

const opacity = (value: number) => Math.max(0, Math.min(1, value));
type Point = ReturnType<typeof meshPosition>;
type ResolvedCommand = readonly [PathCommand[0], ...number[]];

function pathData(commands: readonly ResolvedCommand[]): string {
  return commands.map((command) => command.join(' ')).join(' ');
}

function bezierLength(x: number, y: number, points: readonly number[]): number {
  const [x1, y1, x2, y2, x3, y3] = points;
  let length = 0;
  let previousX = x;
  let previousY = y;
  for (let step = 1; step <= 24; step++) {
    const t = step / 24;
    const u = 1 - t;
    const nextX = x3 === undefined
      ? u * u * x + 2 * u * t * x1! + t * t * x2!
      : u ** 3 * x + 3 * u * u * t * x1! + 3 * u * t * t * x2! + t ** 3 * x3;
    const nextY = y3 === undefined
      ? u * u * y + 2 * u * t * y1! + t * t * y2!
      : u ** 3 * y + 3 * u * u * t * y1! + 3 * u * t * t * y2! + t ** 3 * y3;
    length += Math.hypot(nextX - previousX, nextY - previousY);
    previousX = nextX;
    previousY = nextY;
  }
  return length;
}

function pathContours(commands: readonly ResolvedCommand[]) {
  const contours: { commands: ResolvedCommand[]; length: number }[] = [];
  let x = 0;
  let y = 0;
  let closed = false;
  for (const command of commands) {
    const [op, ...points] = command;
    if (op === 'M') {
      [x, y] = points as [number, number];
      contours.push({ commands: [command], length: 0 });
      closed = false;
      continue;
    }
    if (closed && op !== 'Z') contours.push({ commands: [['M', x, y]], length: 0 });
    const contour = contours.at(-1)!;
    const nextX = op === 'Z' ? contour.commands[0]![1]! : points.at(-2)!;
    const nextY = op === 'Z' ? contour.commands[0]![2]! : points.at(-1)!;
    contour.length += op === 'C' || op === 'Q' ? bezierLength(x, y, points) : Math.hypot(nextX - x, nextY - y);
    contour.commands.push(command);
    x = nextX;
    y = nextY;
    closed = op === 'Z';
  }
  return contours;
}

function trimmedContours(commands: readonly ResolvedCommand[], start: number, end: number, measureLength: boolean) {
  // A normalized dash restarts at each SVG subpath. Allocate the trim interval
  // over the same combined contour length that Skia's trim effect uses.
  const compound = commands.slice(1).some(([op], index) => op === 'M' || commands[index]![0] === 'Z');
  const contours = compound || measureLength ? pathContours(commands) : [{ commands, length: 1 }];
  const total = contours.reduce((sum, contour) => sum + contour.length, 0);
  const spans: { path: string; trim: string; distance: number }[] = [];
  let offset = 0;
  for (const contour of contours) {
    if (!contour.length) continue;
    const from = opacity((start * total - offset) / contour.length);
    const to = opacity((end * total - offset) / contour.length);
    offset += contour.length;
    if (to <= from) continue;
    const trim = from === 0 && to === 1 ? ''
      : ` pathLength="1" stroke-dasharray="${to - from} ${1 - to + from}" stroke-dashoffset="${-from}"`;
    spans.push({ path: pathData(contour.commands), trim, distance: from * contour.length });
  }
  return spans;
}

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
export function assetSVG(
  asset: MotionAsset, channels: Record<string, number>,
  size = { width: asset.artboard.width, height: asset.artboard.height },
  values: Readonly<Record<string, unknown>> = {},
): string {
  const { artboard } = asset;
  const { insetX, insetY } = layoutAsset(artboard, size.width, size.height);
  const defs: string[] = [];
  let hasText = false;
  const licenses = Object.values(asset.fontLicenses ?? {});
  const notices = licenses.length ? `<metadata>${licenses.join('\n').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</metadata>` : '';
  const fonts = Object.entries(asset.fonts ?? {}).map(([name, uri]) => `@font-face{font-family:${name};src:url(${uri})}`);
  if (fonts.length) defs.push(`<style>${fonts.join('')}</style>`);
  const meshImages = new Map<string, string>();
  const imageUri = (name: string) => asset.images![asset.imageSlots?.[name] ?? name]!;
  const read = (value: number | string | undefined, fallback = 0) =>
    typeof value === 'string' ? channels[value]! : value ?? fallback;
  const resolvePath = (commands: readonly PathCommand[]) =>
    commands.map(([op, ...coords]) => [op, ...coords.map((coord) => read(coord))] as const);
  const strokePath = (commands: readonly ResolvedCommand[], stroke: AssetStroke, bounds: number[], alpha: number, filter: string) => {
    const width = Math.min(4096, read(stroke.width));
    const start = opacity(read(stroke.trim?.start));
    const end = opacity(read(stroke.trim?.end, 1));
    if (!(width > 0) || end <= start) return '';
    const trimmed = start > 0 || end < 1;
    const style = `fill="none" stroke-width="${width}" stroke-linecap="${stroke.cap ?? 'butt'}" stroke-linejoin="${stroke.join ?? 'miter'}"`;
    const color = resolveAssetColor(stroke.color, asset.palette ?? {});
    const strokeAlpha = color.length === 9 ? parseInt(color.slice(7), 16) / 255 : 1;
    const group = (paths: string) => `<g opacity="${alpha * strokeAlpha}"${filter}>${paths}</g>`;
    const strokeTag = (path: string, dash = '') =>
      `<path d="${path}" ${style} stroke="${color.slice(0, 7)}"${dash}/>`;
    const phase = read(stroke.dash?.phase);
    const dash = (offset: number) => stroke.dash
      ? ` stroke-dasharray="${stroke.dash.intervals.join(' ')}" stroke-dashoffset="${offset}"`
      : '';
    if (!trimmed) return group(strokeTag(pathData(commands), dash(phase)));
    const spans = trimmedContours(commands, start, end, Boolean(stroke.dash));
    if (!stroke.dash) return group(spans.map(({ path, trim }) => strokeTag(path, trim)).join(''));

    const [x, y, w, h] = bounds as [number, number, number, number];
    const pad = width * 2;
    return group(spans.map(({ path, trim, distance }) => {
      if (!trim) return strokeTag(path, dash(phase));
      const id = `stroke-trim-${defs.length}`;
      defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${x - pad}" y="${y - pad}" width="${w + 2 * pad}" height="${h + 2 * pad}"><path d="${path}" ${style} stroke="#fff"${trim}/></mask>`);
      return strokeTag(path, `${dash(phase - distance)} mask="url(#${id})"`);
    }).join(''));
  };
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
    if (node.kind === 'text') {
      hasText = true;
      const bound = (name: string) => {
        const found = values[name] ?? asset.machine.values?.[name]?.default;
        return typeof found === 'string' ? found : '';
      };
      let value = typeof node.text === 'string' ? node.text : bound(node.text.value);
      const escape = (raw: string) => raw.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const family = node.fonts?.length ? node.fonts.join(',') : 'sans-serif';
      if (node.roll) {
        const progress = read(node.roll.progress);
        const from = bound(node.roll.from);
        const frame = rollFrame(from, value, progress);
        // At rest the roll is its plain text, laid out by the viewer like any other; only a turning frame is drawn in columns.
        if (frame && frame.places.every(({ turn }) => turn === 0)) value = restText(frame);
        else if (frame) {
          // The preview has no text measurement: a digit place is 0.6 of the font size wide and a line 1.2, and right to left the prefix
          // is put on the right. The app lays the number out with Skia; `asset frame --out=*.png` shows that.
          const advance = node.fontSize * 0.6;
          const line = node.fontSize * 1.2;
          const rtl = node.direction === 'rtl';
          const [left, right] = rtl ? [frame.suffix, frame.prefix] : [frame.prefix, frame.suffix];
          // A blank leading place opens as its first digit rolls in, as in the app.
          const widths = frame.places.map(({ current, turn }) => (current < 0 ? turn * advance : advance));
          const digitsWidth = widths.reduce((sum, width) => sum + width, 0);
          const total = ([...left].length + [...right].length) * advance + digitsWidth;
          const align = node.align ?? 'start';
          const x0 = read(node.x) + (align === 'center' ? (node.width - total) / 2 : (align === 'end') === !rtl ? node.width - total : 0);
          const y0 = read(node.y);
          const glyph = (text: string, x: number, y: number) => (text
            ? `<text x="${x}" y="${y}" dominant-baseline="hanging" font-family="${family}" font-size="${node.fontSize}" fill="${node.fill}" style="font-feature-settings: 'tnum' 1">${escape(text)}</text>` : '');
          const digits = x0 + [...left].length * advance;
          let edge = digits;
          const columns = frame.places.map(({ current, next, turn }, i) => {
            const width = widths[i]!;
            edge += width;
            if (width <= 0) return '';
            const id = `roll-${defs.length}`;
            const column = edge - advance;
            defs.push(`<clipPath id="${id}"><rect x="${edge - width}" y="${y0}" width="${width}" height="${line}"/></clipPath>`);
            return `<g clip-path="url(#${id})">${glyph(digitText(current, frame.zero), column, y0 - turn * line)}${turn > 0 ? glyph(digitText(next, frame.zero), column, y0 + (1 - turn) * line) : ''}</g>`;
          }).join('');
          return `${glyph(left, x0, y0)}${columns}${glyph(right, digits + digitsWidth, y0)}`;
        } else value = progress < 0.5 ? from : value;
      }
      if (!value) return '';
      const content = escape(value);
      const direction = node.direction ?? 'ltr';
      const alignment = node.align ?? 'start';
      const shift = alignment === 'center' ? 0.5 : (alignment === 'end') === (direction === 'ltr') ? 1 : 0;
      const anchor = alignment === 'center' ? 'middle' : alignment;
      const features = node.fontFeatures?.map(({ name, value }) => `'${name}' ${value}`).join(', ');
      const featureStyle = features ? ` style="font-feature-settings: ${features}"` : '';
      const x = read(node.x);
      const y = read(node.y);
      const clip = `text-width-${defs.length}`;
      defs.push(`<clipPath id="${clip}"><rect x="${x}" y="${y - node.fontSize}" width="${node.width}" height="${3 * node.fontSize}"/></clipPath>`);
      return `<text x="${x + node.width * shift}" y="${y}" dominant-baseline="hanging" text-anchor="${anchor}" direction="${direction}" font-family="${family}" font-size="${node.fontSize}" fill="${node.fill}" clip-path="url(#${clip})"${featureStyle}>${content}</text>`;
    }
    const alpha = opacity(read(node.opacity, 1));
    if (node.kind === 'mesh') {
      const uri = imageUri(node.image);
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
      return `<image href="${imageUri(node.image)}" x="${read(node.x)}" y="${read(node.y)}" width="${width}" height="${height}" opacity="${alpha}" preserveAspectRatio="none"/>`;
    }
    let fill = node.fill ?? 'none';
    if (typeof fill !== 'string' && 'palette' in fill) fill = resolveAssetColor(fill, asset.palette ?? {});
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
      const bounds = [0, 0, 0, 0];
      if (feather > 0 || (node.stroke?.trim && node.stroke.dash)) {
        // Bézier curves stay within their control points, so these bounds include the entire shape.
        const coordinates = commands.flatMap(([, ...points]) => points);
        const xs = coordinates.filter((_, i) => i % 2 === 0);
        const ys = coordinates.filter((_, i) => i % 2 === 1);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        bounds.splice(0, 4, x, y, Math.max(...xs) - x, Math.max(...ys) - y);
        const strokePad = node.stroke ? 2 * Math.max(0, Math.min(4096, read(node.stroke.width))) : 0;
        filter = edge(x - strokePad, y - strokePad, bounds[2]! + 2 * strokePad, bounds[3]! + 2 * strokePad);
      }
      const path = pathData(commands);
      return (node.fill ? `<path d="${path}" ${style}${filter}/>` : '') +
        (node.stroke ? strokePath(commands, node.stroke, bounds, alpha, filter) : '');
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
  const description = hasText ? '<desc>Single-line SVG text preview. Native Skia draws wrapping and ellipsis.</desc>' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="${-insetX} ${-insetY} ${width + 2 * insetX} ${height + 2 * insetY}">${description}${notices}<defs>${defs.join('')}</defs>${shapes}</svg>\n`;
}
