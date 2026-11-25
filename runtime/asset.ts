import { validateMachine } from './machine-schema.js';
import { EASE_IN, EASE_IN_OUT, EASE_OUT } from '../templates/motion/motion';
import type { Clips, Machine, StateEntry } from '../templates/motion/machine';
import type { AssetAnchor } from './asset-layout';
import { imageSize } from './asset-image';
import { decodeBase64 } from './base64';
import { decodeAssetText, decodeBinaryAsset, isBinaryAsset, isResourceBytes, mapFileResources, resourceDataUri, type AssetResource, type MotionAssetData, type ResourceBytes } from './asset-binary';
import type { MeshNode, MeshVertex } from './asset-mesh';

export const ASSET_SCHEMA = 'skac.asset/1';
export const ASSET_BUNDLE_SCHEMA = 'skac.bundle/1';
/**
 * The file format this runtime reads: the major is the schema's number, and the minor is a file's optional root `minor` (absent is 0).
 * A file only carries a minor when it uses something added after the major's baseline, so every file before then stays loadable by
 * every runtime of that major. This runtime reads files of a newer minor by skipping the fields and node kinds it does not know.
 */
export const ASSET_FORMAT = { major: 1, minor: 0 } as const;
export const MAX_ASSET_BYTES = 1024 * 1024;
export const MAX_ASSET_SOURCE_BYTES = 8 * MAX_ASSET_BYTES;
export const MAX_FEATHER = 64;

export type Scalar = number | string;
type Ease = 'linear' | 'in' | 'out' | 'inOut' | 'hold';
type Key = readonly [ms: number, value: number, ease?: Ease];
type Track = readonly Key[];
export type PathCommand =
  | readonly [op: 'M' | 'L', x: Scalar, y: Scalar]
  | readonly [op: 'Q', controlX: Scalar, controlY: Scalar, x: Scalar, y: Scalar]
  | readonly [op: 'C', control1X: Scalar, control1Y: Scalar, control2X: Scalar, control2Y: Scalar, x: Scalar, y: Scalar]
  | readonly [op: 'Z'];
export type AssetColor = string | { palette: string };
type Shade = AssetColor | { kind: 'radial'; x: Scalar; y: Scalar; radius: Scalar; colors: readonly [string, string] };
export type AssetStroke = {
  color: AssetColor; width: Scalar;
  cap?: 'butt' | 'round' | 'square'; join?: 'miter' | 'round' | 'bevel';
  trim?: { start?: Scalar; end?: Scalar };
  dash?: { intervals: readonly number[]; phase?: Scalar };
};

/**
 * A row: the group's children (texts, images, simple shapes) placed left to right by their ink, `gap` points apart, each with its optical
 * centre on the group's y; `align` puts the row's ink start, centre or end on the group's x. `plate` draws behind, sized from the ink
 * plus padding, and from `widest` (a sample of the bound text) so it never resizes. See asset-ink.ts.
 */
export type AssetRow = {
  gap: number; align?: 'start' | 'center' | 'end'; direction?: 'ltr' | 'rtl';
  plate?: { padding: readonly [number, number]; radius?: number; fill: AssetColor; stroke?: { color: AssetColor; width: number }; widest?: string };
};
type Group = {
  kind: 'group'; x?: Scalar; y?: Scalar; scaleX?: Scalar; scaleY?: Scalar; rotation?: Scalar;
  anchor?: AssetAnchor;
  clip?: readonly PathCommand[];
  points?: Readonly<Record<string, { x: Scalar; y: Scalar }>>;
  row?: AssetRow;
  children: readonly AssetNode[];
};
type Shape = { opacity?: Scalar; feather?: Scalar } & (
  | { kind: 'ellipse'; x: Scalar; y: Scalar; width: Scalar; height: Scalar; fill: Shade }
  | { kind: 'roundRect'; x: Scalar; y: Scalar; width: Scalar; height: Scalar; radius: Scalar; fill: Shade }
  | { kind: 'path'; commands: readonly PathCommand[]; fill?: Shade; stroke?: AssetStroke }
);

type ImageNode = {
  kind: 'image'; image: string; opacity?: Scalar;
  x: Scalar; y: Scalar; width: Scalar; height: Scalar;
};

export type BoundText = string | { value: string };
type FontFeature = { name: string; value: number };
export type AssetTextNode = {
  kind: 'text'; text: BoundText; x: Scalar; y: Scalar; width: number; fontSize: number; fill: string;
  fonts?: readonly string[]; direction?: 'ltr' | 'rtl'; align?: 'start' | 'center' | 'end'; maxLines?: number;
  fontFeatures?: readonly FontFeature[];
  /** Roll the number from another string value to this one as `progress` (a channel) runs 0 to 1; see asset-roll.ts. */
  roll?: { progress: string; from: string; ease?: 'out' | 'linear' };
};
export type AssetSemantic = {
  name: string; label: BoundText; role: 'button' | 'image' | 'text' | 'header';
  bounds: readonly [x: number, y: number, width: number, height: number];
  trigger?: string;
};

export type AssetNode = Group | Shape | ImageNode | MeshNode | AssetTextNode;
export type AssetMarker = { name: string; layer: string; state: string; audio?: string };
export type AssetMarkerEvent = AssetMarker & { at: number };
export type AssetAttachment = { from: string; to: string; maxDistance: number };
export type MotionAsset<M extends Machine = Machine, R extends AssetResource = string> = {
  schema: typeof ASSET_SCHEMA;
  minor?: number;
  name: string;
  artboard: { width: number; height: number; nodes: readonly AssetNode[] };
  channels: Readonly<Record<string, number>>;
  images?: Readonly<Record<string, R>>;
  imageSlots?: Readonly<Record<string, string>>;
  /** The drawn part of each embedded image, as fractions of its box (left, top, right, bottom), from its alpha. Pack writes it. */
  imageInk?: Readonly<Record<string, readonly [number, number, number, number]>>;
  palette?: Readonly<Record<string, string>>;
  fonts?: Readonly<Record<string, R>>;
  fontSlots?: Readonly<Record<string, { readonly fallback?: string }>>;
  fontLicenses?: Readonly<Record<string, string>>;
  audio?: Readonly<Record<string, R>>;
  semantics?: readonly AssetSemantic[];
  clips: Readonly<Record<string, { ms: number; reducedAt?: number; tracks: Readonly<Record<string, Track>> }>>;
  machine: M;
  markers?: readonly AssetMarker[];
  attachments?: readonly AssetAttachment[];
};
export type DrawableMotionAsset = MotionAsset<Machine, AssetResource>;
export type MotionAssetFile<R extends AssetResource = string> = MotionAsset<Machine, R> | {
  schema: typeof ASSET_BUNDLE_SCHEMA;
  minor?: number;
  name: string;
  defaultArtboard: string;
  artboards: Readonly<Record<string, MotionAsset<Machine, R>>>;
  fonts?: MotionAsset<Machine, R>['fonts'];
  fontSlots?: MotionAsset['fontSlots'];
  fontLicenses?: MotionAsset['fontLicenses'];
  audio?: MotionAsset<Machine, R>['audio'];
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const FONT_URI = /^data:font\/(ttf|otf);base64,([A-Za-z0-9+/]+={0,2})$/;
const AUDIO_URI = /^data:audio\/(mpeg|wav|mp4|aac);base64,([A-Za-z0-9+/]+={0,2})$/;
const PATH_ARGUMENTS: Record<string, number> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
const EASES = ['linear', 'in', 'out', 'inOut', 'hold'];
const RESERVED_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

function invalid(at: string, message: string): never {
  throw new Error(`${at}: ${message}`);
}

/** True while reading a file of a newer minor than ASSET_FORMAT: unknown fields and node kinds are skipped, not refused. */
let newerMinor = false;

function record(value: unknown, at: string, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(at, 'expected an object');
  const data = value as Record<string, unknown>;
  if (keys && !newerMinor) for (const key of Object.keys(data)) if (!keys.includes(key)) invalid(`${at}.${key}`, 'unknown field');
  return data;
}

const NODE_KINDS = ['ellipse', 'roundRect', 'path', 'image', 'mesh', 'text', 'group'];

/** In a newer-minor file, drop the nodes whose kind this runtime cannot draw, in place, and draw the rest. */
function knownNodes(value: unknown): unknown {
  if (!newerMinor || !Array.isArray(value)) return value;
  for (let i = value.length - 1; i >= 0; i--) {
    const node = value[i] as { kind?: unknown } | null;
    // Only a well-formed node of a kind added later is skipped; anything malformed is still reported.
    if (node && typeof node === 'object' && typeof node.kind === 'string' && !NODE_KINDS.includes(node.kind)) value.splice(i, 1);
  }
  return value;
}

/**
 * Read a file's format: its schema's major against this runtime's, then its minor. A different major is refused with the way forward;
 * a newer minor is read leniently.
 */
function checkFormat(file: Record<string, unknown>, kind: 'asset' | 'bundle'): void {
  const expected = kind === 'asset' ? ASSET_SCHEMA : ASSET_BUNDLE_SCHEMA;
  const match = typeof file.schema === 'string' ? /^skac\.(asset|bundle)\/(\d+)$/.exec(file.schema) : null;
  if (match && match[1] === kind && Number(match[2]) !== ASSET_FORMAT.major) {
    const major = Number(match[2]);
    invalid(`${kind}.schema`, major > ASSET_FORMAT.major
      ? `this file is format ${file.schema}, and this player reads ${expected}: update skia-motion-runtime to a release that reads format ${major}`
      : `this file is format ${file.schema}, and this player reads ${expected}: run skac asset migrate <file> to upgrade it`);
  }
  if (file.schema !== expected) invalid(`${kind}.schema`, `this player reads ${expected}`);
  if (file.minor !== undefined && (!Number.isInteger(file.minor) || (file.minor as number) < 1 || (file.minor as number) > 1000)) {
    invalid(`${kind}.minor`, 'expected an integer from 1; leave it out for the baseline format');
  }
}

/** The minor a validated file declares: 0 when it has none. */
export function assetMinor(file: { minor?: unknown }): number {
  return typeof file.minor === 'number' ? file.minor : 0;
}

function list(value: unknown, at: string, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) invalid(at, `expected an array of up to ${limit} items`);
  return value;
}

function number(value: unknown, at: string, min = -1e7, max = 1e7): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(at, `expected a number from ${min} to ${max}`);
  }
  return value;
}

function identifier(value: unknown, at: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || RESERVED_KEYS.has(value)) invalid(at, 'expected an identifier');
  return value;
}

function scalar(value: unknown, at: string, channels: Record<string, unknown>, min?: number, max?: number): void {
  if (typeof value === 'string' && Object.hasOwn(channels, value)) return;
  if (typeof value === 'string') invalid(at, `unknown channel "${value}"`);
  number(value, at, min, max);
}

function color(value: unknown, at: string): void {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) invalid(at, 'expected #RRGGBB or #RRGGBBAA');
}

function checkPath(value: unknown, at: string, channels: Record<string, unknown>): void {
  const commands = list(value, at, 1024);
  if (!commands.length) invalid(at, 'a path must start with M');
  commands.forEach((value, i) => {
    const key = `${at}[${i}]`;
    const [op, ...args] = list(value, key, 7);
    if (typeof op !== 'string' || !Object.hasOwn(PATH_ARGUMENTS, op) || args.length !== PATH_ARGUMENTS[op] || (!i && op !== 'M')) {
      invalid(key, 'expected M, L, Q, C or Z with the correct coordinates, starting with M');
    }
    args.forEach((arg, j) => scalar(arg, `${key}[${j + 1}]`, channels));
  });
}

type NodeValidation = {
  channels: Record<string, unknown>;
  images: Record<string, unknown>;
  imageSlots: Record<string, unknown>;
  points: Set<string>;
  fonts: Record<string, unknown>;
  fontSlots: NonNullable<MotionAsset['fontSlots']>;
  values: Record<string, unknown>;
  palette: Record<string, unknown>;
};

function checkColor(value: unknown, at: string, palette: Record<string, unknown>): void {
  if (typeof value === 'string') return color(value, at);
  const name = identifier(record(value, at, ['palette']).palette, `${at}.palette`);
  if (!Object.hasOwn(palette, name)) invalid(at, `unknown palette entry "${name}"`);
}

function checkStroke(value: unknown, at: string, { channels, palette }: NodeValidation): void {
  const stroke = record(value, at, ['color', 'width', 'cap', 'join', 'trim', 'dash']);
  checkColor(stroke.color, `${at}.color`, palette);
  scalar(stroke.width, `${at}.width`, channels, 0, 4096);
  if (stroke.cap !== undefined && !['butt', 'round', 'square'].includes(stroke.cap as string)) invalid(`${at}.cap`, 'expected butt, round or square');
  if (stroke.join !== undefined && !['miter', 'round', 'bevel'].includes(stroke.join as string)) invalid(`${at}.join`, 'expected miter, round or bevel');
  if (stroke.trim !== undefined) {
    const trim = record(stroke.trim, `${at}.trim`, ['start', 'end']);
    for (const key of ['start', 'end']) if (trim[key] !== undefined) scalar(trim[key], `${at}.trim.${key}`, channels, 0, 1);
  }
  if (stroke.dash !== undefined) {
    const dash = record(stroke.dash, `${at}.dash`, ['intervals', 'phase']);
    const intervals = list(dash.intervals, `${at}.dash.intervals`, 32);
    if (intervals.length < 2 || intervals.length % 2) invalid(`${at}.dash.intervals`, 'expected an even number of intervals');
    intervals.forEach((interval, i) => number(interval, `${at}.dash.intervals[${i}]`, 0.001, 4096));
    if (dash.phase !== undefined) scalar(dash.phase, `${at}.dash.phase`, channels);
  }
}

function checkRow(value: unknown, children: unknown, at: string, { palette }: NodeValidation): void {
  const row = record(value, at, ['gap', 'align', 'direction', 'plate']);
  number(row.gap, `${at}.gap`, 0, 256);
  if (row.align !== undefined && !['start', 'center', 'end'].includes(row.align as string)) invalid(`${at}.align`, 'expected start, center or end');
  if (row.direction !== undefined && row.direction !== 'ltr' && row.direction !== 'rtl') invalid(`${at}.direction`, 'expected ltr or rtl');
  if (row.plate !== undefined) {
    const plate = record(row.plate, `${at}.plate`, ['padding', 'radius', 'fill', 'stroke', 'widest']);
    const bound = Array.isArray(children) && children.some((child) => (child as { kind?: unknown; text?: unknown }).kind === 'text' && typeof (child as { text?: unknown }).text !== 'string');
    if (bound && plate.widest === undefined) invalid(`${at}.plate.widest`, 'a plate behind a bound text needs widest, a sample of its longest value, so it never resizes');
    const padding = list(plate.padding, `${at}.plate.padding`, 2);
    if (padding.length !== 2) invalid(`${at}.plate.padding`, 'expected [across, down] in points');
    padding.forEach((side, i) => number(side, `${at}.plate.padding[${i}]`, 0, 256));
    if (plate.radius !== undefined) number(plate.radius, `${at}.plate.radius`, 0, 4096);
    checkColor(plate.fill, `${at}.plate.fill`, palette);
    if (plate.stroke !== undefined) {
      const stroke = record(plate.stroke, `${at}.plate.stroke`, ['color', 'width']);
      checkColor(stroke.color, `${at}.plate.stroke.color`, palette);
      number(stroke.width, `${at}.plate.stroke.width`, 0, 256);
    }
    if (plate.widest !== undefined && (typeof plate.widest !== 'string' || !plate.widest || plate.widest.length > 256)) {
      invalid(`${at}.plate.widest`, 'expected a sample of the widest value, 1 to 256 characters');
    }
  }
  list(children, `${at.slice(0, -4)}.children`, 8).forEach((child, i) => {
    const key = `${at.slice(0, -4)}.children[${i}]`;
    const kind = (child as { kind?: unknown } | null)?.kind;
    if (!['text', 'image', 'ellipse', 'roundRect'].includes(kind as string)) invalid(key, 'a row places texts, images, ellipses and round rects');
    // A row's text is placed by its measured ink, so it draws in a face of the asset's (left out, pack embeds the default one): the
    // platform font (fonts: []) differs by phone, and check cannot measure it the way the phone draws it.
    const fonts = (child as { fonts?: unknown }).fonts;
    if (kind === 'text' && fonts !== undefined && !list(fonts, `${key}.fonts`, 8).length) {
      invalid(`${key}.fonts`, 'a text in a row needs an embedded font or a font slot, or no fonts field for the default one');
    }
  });
}

function checkText(value: unknown, at: string, values: Record<string, unknown>): void {
  if (typeof value === 'string') {
    if (value.length > 4096) invalid(at, 'expected at most 4096 characters');
    return;
  }
  const input = identifier(record(value, at, ['value']).value, `${at}.value`);
  if ((values[input] as { type?: string } | undefined)?.type !== 'string') {
    invalid(`${at}.value`, 'expected a string value from machine.values');
  }
}

function resourceMap(value: unknown, at: string, pattern: RegExp) {
  if (value === undefined) return {};
  const resources = record(value, at);
  if (Object.keys(resources).length > 32) invalid(at, 'expected at most 32 resources');
  for (const [name, uri] of Object.entries(resources)) {
    const key = `${at}.${name}`;
    identifier(name, key);
    if (isResourceBytes(uri)) {
      if (!pattern.test(`data:${uri.mime};base64,AAAA`)) invalid(key, 'invalid embedded resource media type');
      if (pattern === FONT_URI && !hasFontHeader(uri.bytes)) invalid(key, 'expected a TTF or OTF font header');
      continue;
    }
    const match = typeof uri === 'string' ? pattern.exec(uri) : null;
    if (!match || match[0] !== uri || match[2]!.length % 4 !== 0) invalid(key, 'expected an embedded base64 data URI');
    if (pattern === FONT_URI) {
      const encoded = match[2]!;
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
      if (!hasFontHeader(decodeBase64(encoded.slice(0, 16)), encoded.length * 3 / 4 - padding)) {
        invalid(key, 'expected a TTF or OTF font header');
      }
    }
  }
  return resources;
}

export function hasFontHeader(bytes: Uint8Array, size = bytes.byteLength): boolean {
  if (bytes.byteLength < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint32(0);
  const tables = view.getUint16(4);
  return (format === 0x00010000 || format === 0x4f54544f || format === 0x74727565 || format === 0x74797031)
    && tables > 0 && 12 + 16 * tables <= size;
}

function checkFontLicenses(value: unknown, fonts: Record<string, unknown>, at: string): void {
  if (value === undefined) return;
  for (const [name, license] of Object.entries(record(value, at))) {
    if (!Object.hasOwn(fonts, name) || typeof license !== 'string' || license.length > 16_384) {
      invalid(`${at}.${name}`, 'expected a license of up to 16384 characters for a declared font');
    }
  }
}

function checkFontSlots(value: unknown, fonts: Record<string, unknown>, at: string): NonNullable<MotionAsset['fontSlots']> {
  if (value === undefined) return {};
  const slots = Object.entries(record(value, at));
  if (slots.length > 32) invalid(at, 'expected at most 32 font slots');
  const names = new Set(Object.keys(fonts).map((name) => name.toLowerCase()));
  for (const [name, entry] of slots) {
    const key = `${at}.${name}`;
    identifier(name, key);
    if (names.has(name.toLowerCase())) invalid(key, 'font names and slot aliases must be distinct');
    names.add(name.toLowerCase());
    const { fallback } = record(entry, key, ['fallback']);
    if (fallback !== undefined && (typeof fallback !== 'string' || !Object.hasOwn(fonts, fallback))) {
      invalid(`${key}.fallback`, 'expected an embedded font name');
    }
  }
  return value as NonNullable<MotionAsset['fontSlots']>;
}

function registerPoint(name: string, at: string, points: Set<string>): void {
  identifier(name, at);
  if (points.has(name)) invalid(at, 'duplicate point name');
  points.add(name);
}

function checkChildren(value: unknown, at: string, context: NodeValidation, depth: number): void {
  if (depth >= 16) invalid(at, 'nodes are nested more than 16 levels');
  list(knownNodes(value), at, 256).forEach((child, i) => checkNode(child, `${at}[${i}]`, context, depth + 1));
}

function checkMesh(node: Record<string, unknown>, at: string, context: NodeValidation, depth: number): void {
  record(node, at, ['kind', 'image', 'vertices', 'indices', 'opacity', 'pins']);
  const vertices = list(node.vertices, `${at}.vertices`, 1024).map((value, i) => {
    const key = `${at}.vertices[${i}]`;
    const vertex = list(value, key, 4);
    if (vertex.length !== 4) invalid(key, 'expected [x, y, u, v]');
    scalar(vertex[0], `${key}[0]`, context.channels);
    scalar(vertex[1], `${key}[1]`, context.channels);
    number(vertex[2], `${key}[2]`, 0, 1);
    number(vertex[3], `${key}[3]`, 0, 1);
    return vertex as unknown as MeshVertex;
  });
  if (vertices.length < 3) invalid(`${at}.vertices`, 'expected at least three vertices');
  const indices = list(node.indices, `${at}.indices`, 6144).map((value, i) => {
    const key = `${at}.indices[${i}]`;
    const index = number(value, key, 0, vertices.length - 1);
    if (!Number.isInteger(index)) invalid(key, 'expected an integer vertex index');
    return index;
  });
  if (!indices.length || indices.length % 3 !== 0) invalid(`${at}.indices`, 'expected index triples');
  for (let i = 0; i < indices.length; i += 3) {
    const [, , au, av] = vertices[indices[i]!]!;
    const [, , bu, bv] = vertices[indices[i + 1]!]!;
    const [, , cu, cv] = vertices[indices[i + 2]!]!;
    const area = (bu - au) * (cv - av) - (bv - av) * (cu - au);
    if (Math.abs(area) < 1e-9) invalid(`${at}.indices[${i}]`, 'triangle needs three non-collinear texture coordinates');
  }
  if (node.pins === undefined) return;
  for (const [name, value] of Object.entries(record(node.pins, `${at}.pins`))) {
    const key = `${at}.pins.${name}`;
    registerPoint(name, key, context.points);
    const pin = record(value, key, ['triangle', 'weights', 'children']);
    const triangle = number(pin.triangle, `${key}.triangle`, 0, indices.length / 3 - 1);
    if (!Number.isInteger(triangle)) invalid(`${key}.triangle`, 'expected an integer triangle index');
    const weights = list(pin.weights, `${key}.weights`, 3);
    if (weights.length !== 3) invalid(`${key}.weights`, 'expected one weight per vertex');
    const sum = weights.reduce<number>((total, value, i) => total + number(value, `${key}.weights[${i}]`, 0, 1), 0);
    if (Math.abs(sum - 1) > 1e-6) invalid(`${key}.weights`, 'weights must add up to 1');
    if (pin.children !== undefined) checkChildren(pin.children, `${key}.children`, context, depth);
  }
}

function checkNode(value: unknown, at: string, context: NodeValidation, depth: number): void {
  const { channels, images, imageSlots, points } = context;
  const node = record(value, at);
  if (node.kind === 'text') {
    record(node, at, ['kind', 'text', 'x', 'y', 'width', 'fontSize', 'fill', 'fonts', 'direction', 'align', 'maxLines', 'fontFeatures', 'roll']);
    checkText(node.text, `${at}.text`, context.values);
    if (node.roll !== undefined) {
      const roll = record(node.roll, `${at}.roll`, ['progress', 'from', 'ease']);
      if (roll.ease !== undefined && roll.ease !== 'out' && roll.ease !== 'linear') invalid(`${at}.roll.ease`, 'expected out (the default) or linear');
      if (typeof node.text === 'string') invalid(`${at}.text`, 'a rolling text binds its to-value: { value: "<string value>" }');
      if (typeof roll.progress !== 'string' || !Object.hasOwn(channels, roll.progress)) invalid(`${at}.roll.progress`, 'expected a declared channel');
      if (typeof roll.from !== 'string' || (context.values[roll.from] as { type?: string } | undefined)?.type !== 'string') {
        invalid(`${at}.roll.from`, 'expected a string value from machine.values');
      }
    }
    scalar(node.x, `${at}.x`, channels);
    scalar(node.y, `${at}.y`, channels);
    number(node.width, `${at}.width`, 1, 4096);
    number(node.fontSize, `${at}.fontSize`, 1, 512);
    color(node.fill, `${at}.fill`);
    if (node.fonts !== undefined) list(node.fonts, `${at}.fonts`, 8).forEach((name, i) => {
      if (typeof name !== 'string' || (!Object.hasOwn(context.fonts, name) && !Object.hasOwn(context.fontSlots, name))) {
        invalid(`${at}.fonts[${i}]`, 'unknown embedded font or font slot');
      }
    });
    if (node.fontFeatures !== undefined) {
      const names = new Set<string>();
      list(node.fontFeatures, `${at}.fontFeatures`, 16).forEach((value, i) => {
        const key = `${at}.fontFeatures[${i}]`;
        const feature = record(value, key, ['name', 'value']);
        if (typeof feature.name !== 'string' || !/^[a-zA-Z0-9]{4}$/.test(feature.name)) {
          invalid(`${key}.name`, 'expected a four-character OpenType feature tag');
        }
        if (names.has(feature.name)) invalid(`${key}.name`, 'duplicate font feature');
        names.add(feature.name);
        if (!Number.isInteger(number(feature.value, `${key}.value`, 0, 65535))) {
          invalid(`${key}.value`, 'expected an integer');
        }
      });
    }
    if (node.direction !== undefined && node.direction !== 'ltr' && node.direction !== 'rtl') invalid(`${at}.direction`, 'expected ltr or rtl');
    if (node.align !== undefined && !['start', 'center', 'end'].includes(node.align as string)) invalid(`${at}.align`, 'expected start, center or end');
    if (node.maxLines !== undefined && !Number.isInteger(number(node.maxLines, `${at}.maxLines`, 1, 16))) {
      invalid(`${at}.maxLines`, 'expected an integer');
    }
    return;
  }
  if (node.kind === 'group') {
    knownNodes(node.children);
    record(node, at, ['kind', 'children', 'x', 'y', 'scaleX', 'scaleY', 'rotation', 'anchor', 'clip', 'points', 'row']);
    if (node.row !== undefined) checkRow(node.row, node.children, `${at}.row`, context);
    for (const key of ['x', 'y', 'scaleX', 'scaleY', 'rotation']) {
      if (node[key] !== undefined) scalar(node[key], `${at}.${key}`, channels);
    }
    if (node.points !== undefined) {
      for (const [name, rawPoint] of Object.entries(record(node.points, `${at}.points`))) {
        const key = `${at}.points.${name}`;
        registerPoint(name, key, points);
        const point = record(rawPoint, key, ['x', 'y']);
        scalar(point.x, `${key}.x`, channels);
        scalar(point.y, `${key}.y`, channels);
      }
    }
    if (node.clip !== undefined) checkPath(node.clip, `${at}.clip`, channels);
    if (node.anchor !== undefined) {
      if (depth > 0) invalid(`${at}.anchor`, 'anchors belong to top-level groups');
      const anchor = record(node.anchor, `${at}.anchor`, ['x', 'y']);
      if (anchor.x === undefined && anchor.y === undefined) invalid(`${at}.anchor`, 'give an x or y anchor');
      if (anchor.x !== undefined && !['left', 'center', 'right'].some((value) => value === anchor.x)) {
        invalid(`${at}.anchor.x`, 'expected left, center or right');
      }
      if (anchor.y !== undefined && !['top', 'center', 'bottom'].some((value) => value === anchor.y)) {
        invalid(`${at}.anchor.y`, 'expected top, center or bottom');
      }
    }
    checkChildren(node.children, `${at}.children`, context, depth);
    return;
  }
  if (node.kind === 'image' || node.kind === 'mesh') {
    if (typeof node.image !== 'string' || (!Object.hasOwn(images, node.image) && !Object.hasOwn(imageSlots, node.image))) {
      invalid(`${at}.image`, 'expected a name from images or imageSlots');
    }
    if (node.opacity !== undefined) scalar(node.opacity, `${at}.opacity`, channels, 0, 1);
    if (node.kind === 'mesh') {
      checkMesh(node, at, context, depth);
    } else {
      record(node, at, ['kind', 'image', 'x', 'y', 'width', 'height', 'opacity']);
      for (const key of ['x', 'y']) scalar(node[key], `${at}.${key}`, channels);
      for (const key of ['width', 'height']) scalar(node[key], `${at}.${key}`, channels, 0);
    }
    return;
  }
  if (node.kind === 'path') {
    record(node, at, ['kind', 'fill', 'opacity', 'feather', 'commands', 'stroke']);
    checkPath(node.commands, `${at}.commands`, channels);
    if (node.stroke !== undefined) checkStroke(node.stroke, `${at}.stroke`, context);
  } else if (node.kind === 'ellipse' || node.kind === 'roundRect') {
    const keys = ['kind', 'fill', 'opacity', 'feather', 'x', 'y', 'width', 'height'];
    if (node.kind === 'roundRect') keys.push('radius');
    record(node, at, keys);
    for (const key of ['x', 'y', 'width', 'height']) scalar(node[key], `${at}.${key}`, channels, key === 'x' || key === 'y' ? undefined : 0);
    if (node.kind === 'roundRect') scalar(node.radius, `${at}.radius`, channels, 0);
  } else {
    invalid(`${at}.kind`, 'expected ellipse, roundRect, path, image, mesh, text or group');
  }
  if (node.opacity !== undefined) scalar(node.opacity, `${at}.opacity`, channels, 0, 1);
  if (node.feather !== undefined) scalar(node.feather, `${at}.feather`, channels, 0, MAX_FEATHER);
  if (node.kind === 'path' && node.fill === undefined && node.stroke !== undefined) return;
  if (typeof node.fill === 'string') {
    color(node.fill, `${at}.fill`);
    return;
  }
  if (node.fill && typeof node.fill === 'object' && Object.hasOwn(node.fill, 'palette')) {
    checkColor(node.fill, `${at}.fill`, context.palette);
    return;
  }
  const fill = record(node.fill, `${at}.fill`, ['kind', 'x', 'y', 'radius', 'colors']);
  if (fill.kind !== 'radial') invalid(`${at}.fill.kind`, 'expected radial');
  scalar(fill.x, `${at}.fill.x`, channels);
  scalar(fill.y, `${at}.fill.y`, channels);
  scalar(fill.radius, `${at}.fill.radius`, channels, 0.001);
  const colors = list(fill.colors, `${at}.fill.colors`, 2);
  if (colors.length !== 2) invalid(`${at}.fill.colors`, 'expected two colors');
  colors.forEach((item, i) => color(item, `${at}.fill.colors[${i}]`));
}

function validateAsset(value: unknown): DrawableMotionAsset {
  // The format comes first: a file of another major is told how to go on, not which of its fields this runtime does not know.
  checkFormat(record(value, 'asset'), 'asset');
  const data = record(value, 'asset', [
    'schema', 'minor', 'name', 'artboard', 'channels', 'clips', 'machine', 'markers', 'images', 'imageSlots', 'imageInk', 'palette', 'attachments', 'fonts', 'fontSlots', 'fontLicenses', 'audio', 'semantics',
  ]);
  identifier(data.name, 'asset.name');
  const machine = record(data.machine, 'machine');
  const values = machine.values === undefined ? {} : record(machine.values, 'machine.values');
  const fonts = resourceMap(data.fonts, 'fonts', FONT_URI);
  const fontSlots = checkFontSlots(data.fontSlots, fonts, 'fontSlots');
  checkFontLicenses(data.fontLicenses, fonts, 'fontLicenses');
  const audio = resourceMap(data.audio, 'audio', AUDIO_URI);
  const palette = data.palette === undefined ? {} : record(data.palette, 'palette');
  for (const [name, value] of Object.entries(palette)) {
    identifier(name, `palette.${name}`);
    color(value, `palette.${name}`);
  }
  const channels = record(data.channels, 'channels');
  for (const [name, value] of Object.entries(channels)) {
    identifier(name, `channels.${name}`);
    number(value, `channels.${name}`);
  }
  const images = data.images === undefined ? {} : record(data.images, 'images');
  const imageSlots = data.imageSlots === undefined ? {} : record(data.imageSlots, 'imageSlots');
  for (const [name, fallback] of Object.entries(imageSlots)) {
    const at = `imageSlots.${name}`;
    identifier(name, at);
    if (Object.hasOwn(images, name)) invalid(at, 'the slot name must be distinct from its embedded fallback');
    if (typeof fallback !== 'string' || !Object.hasOwn(images, fallback)) invalid(at, 'expected an embedded fallback from images');
  }
  if (data.imageInk !== undefined) {
    for (const [name, value] of Object.entries(record(data.imageInk, 'imageInk'))) {
      if (!Object.hasOwn(images, name)) invalid(`imageInk.${name}`, 'expected the name of an embedded image');
      const box = list(value, `imageInk.${name}`, 4);
      if (box.length !== 4) invalid(`imageInk.${name}`, 'expected [left, top, right, bottom] as fractions of the image');
      box.forEach((side, i) => number(side, `imageInk.${name}[${i}]`, 0, 1));
    }
  }
  let pixels = 0;
  for (const [name, uri] of Object.entries(images)) {
    const at = `images.${name}`;
    identifier(name, at);
    const size = imageSize(uri);
    if (!size || size.width < 1 || size.height < 1 || size.width > 4096 || size.height > 4096) {
      invalid(at, 'expected an embedded PNG or WebP data URI with dimensions from 1 to 4096 pixels');
    }
    pixels += size.width * size.height;
    if (pixels > 16 * 1024 * 1024) invalid('images', 'embedded images exceed 16 Mi pixels in total');
  }
  const artboard = record(data.artboard, 'artboard', ['width', 'height', 'nodes']);
  number(artboard.width, 'artboard.width', 1, 4096);
  number(artboard.height, 'artboard.height', 1, 4096);
  const nodes = list(knownNodes(artboard.nodes), 'artboard.nodes', 256);
  if (!nodes.length) invalid('artboard.nodes', 'add at least one shape');
  const context = { channels, images, imageSlots, fonts, fontSlots, values, palette, points: new Set<string>() };
  nodes.forEach((node, i) => checkNode(node, `artboard.nodes[${i}]`, context, 0));
  if (data.semantics !== undefined) {
    const names = new Set<string>();
    list(data.semantics, 'semantics', 64).forEach((item, i) => {
      const at = `semantics[${i}]`;
      const entry = record(item, at, ['name', 'role', 'label', 'bounds', 'trigger']);
      const name = identifier(entry.name, `${at}.name`);
      if (names.has(name)) invalid(`${at}.name`, 'duplicate semantic name');
      names.add(name);
      if (!['button', 'image', 'text', 'header'].includes(entry.role as string)) invalid(`${at}.role`, 'unknown role');
      checkText(entry.label, `${at}.label`, values);
      const bounds = list(entry.bounds, `${at}.bounds`, 4);
      if (bounds.length !== 4) invalid(`${at}.bounds`, 'expected x, y, width and height');
      bounds.forEach((side, index) => number(side, `${at}.bounds[${index}]`, index < 2 ? -4096 : 1, 4096));
      if (entry.trigger !== undefined) {
        const trigger = identifier(entry.trigger, `${at}.trigger`);
        const property = values[trigger] as { type?: string; bind?: string } | undefined;
        if (entry.role !== 'button' || property?.type !== 'trigger' || property.bind === 'out') {
          invalid(`${at}.trigger`, 'expected a writable trigger on a button');
        }
      }
    });
  }
  if (data.attachments !== undefined) {
    list(data.attachments, 'attachments', 256).forEach((item, i) => {
      const at = `attachments[${i}]`;
      const attachment = record(item, at, ['from', 'to', 'maxDistance']);
      for (const key of ['from', 'to']) {
        const point = identifier(attachment[key], `${at}.${key}`);
        if (!context.points.has(point)) invalid(`${at}.${key}`, `unknown point "${point}"`);
      }
      number(attachment.maxDistance, `${at}.maxDistance`, 0);
    });
  }
  const clips = record(data.clips, 'clips');
  for (const [name, value] of Object.entries(clips)) {
    const at = `clips.${name}`;
    identifier(name, at);
    const clip = record(value, at, ['ms', 'reducedAt', 'tracks']);
    const ms = number(clip.ms, `${at}.ms`, 0, 60000);
    if (clip.reducedAt !== undefined) number(clip.reducedAt, `${at}.reducedAt`, 0, ms);
    for (const [channel, value] of Object.entries(record(clip.tracks, `${at}.tracks`))) {
      const key = `${at}.tracks.${channel}`;
      if (!Object.hasOwn(channels, channel)) invalid(key, 'unknown channel');
      const track = list(value, key, 1024);
      if (!track.length) invalid(key, 'a track needs at least one keyframe');
      let previous = -1;
      track.forEach((value, i) => {
        const at = `${key}[${i}]`;
        const frame = list(value, at, 3);
        if (frame.length < 2) invalid(at, 'expected [ms, value, ease?]');
        const time = number(frame[0], `${at}[0]`, 0, ms);
        if (time <= previous) invalid(at, 'keyframe times must be strictly increasing');
        previous = time;
        number(frame[1], `${at}[1]`);
        if (frame.length === 3 && (typeof frame[2] !== 'string' || !EASES.includes(frame[2]))) {
          invalid(`${at}[2]`, 'expected linear, in, out, inOut or hold');
        }
      });
    }
  }
  if (machine.hits !== undefined) invalid('machine.hits', 'packed scenes use host input and semantic regions');
  list(machine.layers, 'machine.layers', 32).forEach((value, i) => {
    const at = `machine.layers[${i}]`;
    const layer = record(value, at);
    if (Object.keys(record(layer.states, `${at}.states`)).length > 128) invalid(`${at}.states`, 'maximum of 128 states per layer');
    if (layer.transitions !== undefined) list(layer.transitions, `${at}.transitions`, 512);
  });
  const checked = validateMachine(machine, { clips: clips as MotionAsset['clips'], lenient: newerMinor });
  if (checked.problems.length) {
    const { where, error, hint } = checked.problems[0]!;
    invalid(where ? `machine.${where}` : 'machine', `${error}. ${hint}`);
  }
  const typed = data as DrawableMotionAsset;
  const names = new Set();
  if (data.markers !== undefined) {
    list(data.markers, 'markers', 256).forEach((item, i) => {
      const at = `markers[${i}]`;
      const marker = record(item, at, ['name', 'layer', 'state', 'audio']);
      const name = identifier(marker.name, `${at}.name`);
      if (names.has(name)) invalid(`${at}.name`, 'duplicate marker name');
      names.add(name);
      const layer = typed.machine.layers.find((layer) => layer.name === marker.layer);
      const state = identifier(marker.state, `${at}.state`);
      if (!layer || !Object.hasOwn(layer.states, state)) invalid(at, 'unknown layer or state');
      if (marker.audio !== undefined && (typeof marker.audio !== 'string' || !Object.hasOwn(audio, marker.audio))) {
        invalid(`${at}.audio`, 'unknown embedded audio cue');
      }
    });
  }
  return typed;
}

/** Read the portable scene as editable JSON-compatible data. */
export function parseAssetFile(source: MotionAssetData): MotionAssetFile {
  const file = parseDrawableFile(source);
  if (typeof source === 'string' || !isBinaryAsset(source)) return file as MotionAssetFile;
  const uris = new Map<ResourceBytes, string>();
  return mapFileResources(file, (value) => resourceDataUri(value as AssetResource, uris)) as MotionAssetFile;
}

/** The CLI may prune unused resources before enforcing the shipped limit. */
export function parseAssetSource(text: string): MotionAssetFile {
  return parseAssetText(text, MAX_ASSET_SOURCE_BYTES) as MotionAssetFile;
}

function parseDrawableFile(source: MotionAssetData): MotionAssetFile<AssetResource> {
  if (typeof source === 'string') return parseAssetText(source, MAX_ASSET_BYTES);
  if (!(source instanceof Uint8Array) || source.length > MAX_ASSET_BYTES) invalid('asset', 'expected an asset of at most 1 MiB');
  if (isBinaryAsset(source)) return validateAssetFile(decodeBinaryAsset(source, parseJSON));
  return validateAssetFile(parseJSON(decodeAssetText(source)));
}

function parseAssetText(text: string, limit: number): MotionAssetFile<AssetResource> {
  const message = `expected a JSON asset of at most ${limit / MAX_ASSET_BYTES} MiB`;
  if (typeof text !== 'string' || text.length > limit) invalid('asset', message);
  const bytes = encodeURI(text).replace(/%[0-9A-F]{2}/g, 'x').length;
  if (bytes > limit) invalid('asset', message);
  return validateAssetFile(parseJSON(text));
}

function parseJSON(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (RESERVED_KEYS.has(key)) invalid(key, 'reserved field name');
    if (typeof value === 'number' && !Number.isFinite(value)) invalid(key, 'expected a finite number');
    return value;
  });
}

function validateAssetFile(decoded: unknown): MotionAssetFile<AssetResource> {
  const file = record(decoded, 'asset');
  const minor = typeof file.minor === 'number' ? file.minor : 0;
  newerMinor = Number.isInteger(minor) && minor > ASSET_FORMAT.minor;
  try {
    return validateFormatted(file);
  } finally {
    newerMinor = false;
  }
}

function validateFormatted(file: Record<string, unknown>): MotionAssetFile<AssetResource> {
  if (typeof file.schema !== 'string' || !file.schema.startsWith('skac.bundle/')) return validateAsset(file);
  checkFormat(file, 'bundle');
  record(file, 'bundle', ['schema', 'minor', 'name', 'defaultArtboard', 'artboards', 'fonts', 'fontSlots', 'fontLicenses', 'audio']);
  const name = identifier(file.name, 'bundle.name');
  const defaultArtboard = identifier(file.defaultArtboard, 'bundle.defaultArtboard');
  const artboards = record(file.artboards, 'bundle.artboards');
  const fonts = resourceMap(file.fonts, 'bundle.fonts', FONT_URI) as NonNullable<DrawableMotionAsset['fonts']>;
  const fontSlots = checkFontSlots(file.fontSlots, fonts, 'bundle.fontSlots');
  checkFontLicenses(file.fontLicenses, fonts, 'bundle.fontLicenses');
  const fontLicenses = file.fontLicenses as MotionAsset['fontLicenses'];
  const audio = resourceMap(file.audio, 'bundle.audio', AUDIO_URI) as NonNullable<DrawableMotionAsset['audio']>;
  const entries = Object.entries(artboards);
  if (entries.length < 1 || entries.length > 16) invalid('bundle.artboards', 'expected one to sixteen artboards');
  if (!Object.hasOwn(artboards, defaultArtboard)) invalid('bundle.defaultArtboard', 'unknown artboard');
  return {
    schema: ASSET_BUNDLE_SCHEMA, name, defaultArtboard,
    ...(typeof file.minor === 'number' && { minor: file.minor }),
    ...(Object.keys(fonts).length && { fonts }),
    ...(Object.keys(fontSlots).length && { fontSlots }),
    ...(fontLicenses && { fontLicenses }),
    ...(Object.keys(audio).length && { audio }),
    artboards: Object.fromEntries(entries.map(([key, value]) => {
      identifier(key, `bundle.artboards.${key}`);
      try {
        const board = record(value, `bundle.artboards.${key}`);
        const localFonts = board.fonts === undefined ? {} : record(board.fonts, 'fonts');
        const localSlots = board.fontSlots === undefined ? {} : record(board.fontSlots, 'fontSlots');
        const localAudio = board.audio === undefined ? {} : record(board.audio, 'audio');
        const localLicenses = board.fontLicenses === undefined ? {} : record(board.fontLicenses, 'fontLicenses');
        validateAsset({
          ...board, fonts: { ...fonts, ...localFonts }, fontSlots: { ...fontSlots, ...localSlots },
          fontLicenses: { ...fontLicenses, ...localLicenses }, audio: { ...audio, ...localAudio },
        });
        return [key, board as DrawableMotionAsset];
      } catch (error) {
        invalid(`bundle.artboards.${key}`, (error as Error).message);
      }
    })),
  };
}

export function selectArtboard<R extends AssetResource>(file: MotionAssetFile<R>, artboard?: string): MotionAsset<Machine, R> {
  if (file.schema === ASSET_SCHEMA) {
    if (artboard === undefined || artboard === file.name) return file;
    invalid('artboard', `unknown artboard "${artboard}". Available: ${file.name}`);
  }
  const name = artboard ?? file.defaultArtboard;
  if (!Object.hasOwn(file.artboards, name)) {
    invalid('artboard', `unknown artboard "${name}". Available: ${Object.keys(file.artboards).join(', ')}`);
  }
  const selected = file.artboards[name]!;
  return {
    ...selected,
    ...(file.fonts && { fonts: { ...file.fonts, ...selected.fonts } }),
    ...(file.fontSlots && { fontSlots: { ...file.fontSlots, ...selected.fontSlots } }),
    ...(file.fontLicenses && { fontLicenses: { ...file.fontLicenses, ...selected.fontLicenses } }),
    ...(file.audio && { audio: { ...file.audio, ...selected.audio } }),
  };
}

export function parseAsset(source: MotionAssetData, artboard?: string): MotionAsset {
  return selectArtboard(parseAssetFile(source), artboard);
}

/** Decode a scene for drawing and preserve encoded image and font bytes for Skia. */
export function parseDrawableAsset(source: MotionAssetData, artboard?: string): DrawableMotionAsset {
  return selectArtboard(parseDrawableFile(source), artboard);
}

export function assetTextNodes(
  nodes: readonly AssetNode[], parent = 'artboard.nodes', text: { node: AssetTextNode; where: string }[] = [],
) {
  nodes.forEach((node, index) => {
    const where = `${parent}[${index}]`;
    if (node.kind === 'text') text.push({ node, where });
    if (node.kind === 'group') assetTextNodes(node.children, `${where}.children`, text);
    if (node.kind === 'mesh') {
      for (const [name, pin] of Object.entries(node.pins ?? {})) {
        if (pin.children) assetTextNodes(pin.children, `${where}.pins.${name}.children`, text);
      }
    }
  });
  return text;
}

/** Bind fonts for the selected board and report referenced slots that still need a face. */
export function resolveAssetFonts<R extends AssetResource, Host>(
  asset: MotionAsset<Machine, R>, overrides: Readonly<Record<string, Host>> = {},
) {
  const slots = asset.fontSlots ?? {};
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(slots, name)) invalid(`fontSlots.${name}`, 'unknown font slot');
  }
  const fonts: Record<string, R | Host> = { ...asset.fonts };
  const missing: string[] = [];
  if (Object.keys(slots).length) {
    const used = new Set<string>();
    for (const { node } of assetTextNodes(asset.artboard.nodes)) {
      for (const name of node.fonts ?? []) used.add(name);
    }
    const replacedFallbacks = new Set<string>();
    const activeFallbacks = new Set<string>();
    for (const [name, { fallback }] of Object.entries(slots)) {
      if (!used.has(name)) continue;
      const host = Object.hasOwn(overrides, name) ? overrides[name] : undefined;
      const face = host ?? (fallback === undefined ? undefined : asset.fonts?.[fallback]);
      if (face === undefined) missing.push(name);
      else fonts[name] = face;
      if (fallback !== undefined) {
        if (host == null) activeFallbacks.add(fallback);
        else replacedFallbacks.add(fallback);
      }
    }
    replacedFallbacks.forEach((fallback) => {
      if (!used.has(fallback) && !activeFallbacks.has(fallback)) delete fonts[fallback];
    });
  }
  return { fonts, missing };
}

export function resolveAssetColor(value: AssetColor, palette: Readonly<Record<string, string>>): string {
  'worklet';
  return typeof value === 'string' ? value : palette[value.palette]!;
}

export function bindAssetPalette<R extends AssetResource>(asset: MotionAsset<Machine, R>, overrides?: Readonly<Record<string, string>>): MotionAsset<Machine, R> {
  if (!overrides) return asset;
  for (const [name, value] of Object.entries(overrides)) {
    if (!asset.palette || !Object.hasOwn(asset.palette, name)) invalid(`palette.${name}`, 'unknown palette entry');
    color(value, `palette.${name}`);
  }
  return { ...asset, palette: { ...asset.palette, ...overrides } };
}

/** Image names used by the drawing. Unreferenced library entries can be omitted from playback. */
export function usedAssetImages(nodes: readonly AssetNode[], names = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.kind === 'image' || node.kind === 'mesh') names.add(node.image);
    if (node.kind === 'group') usedAssetImages(node.children, names);
    if (node.kind === 'mesh') {
      for (const pin of Object.values(node.pins ?? {})) {
        if (pin.children) usedAssetImages(pin.children, names);
      }
    }
  }
  return names;
}

function trackValue(track: Track, ms: number): number {
  'worklet';
  const first = track[0]!;
  if (ms <= first[0]) return first[1];
  let low = 1;
  let high = track.length - 1;
  const last = track[high]!;
  if (!(ms <= last[0])) return last[1];
  // Find the first key at or after the sample. Its easing controls the segment ending there.
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ms <= track[middle]![0]) high = middle;
    else low = middle + 1;
  }
  const [end, to, ease] = track[low]!;
  const [start, from] = track[low - 1]!;
  if (ease === 'hold') return ms < end ? from : to;
  const p = (ms - start) / (end - start);
  const eased = ease === 'in' ? EASE_IN(p) : ease === 'out' ? EASE_OUT(p) : ease === 'inOut' ? EASE_IN_OUT(p) : p;
  return from + (to - from) * eased;
}

/** Adapt data tracks to the existing state-machine clip interface. */
export function assetClips(asset: Pick<MotionAsset, 'clips'>): Clips {
  return Object.fromEntries(Object.entries(asset.clips).map(([name, { ms, reducedAt, tracks }]) => {
    const channels = Object.entries(tracks);
    return [name, {
      ms, reducedAt,
      play(localMs: number) {
        'worklet';
        const pose: Record<string, number> = {};
        for (const [channel, keys] of channels) pose[channel] = trackValue(keys, localMs);
        return { channels: pose };
      },
    }];
  }));
}

export function assetMarkerEvents(asset: Pick<MotionAsset, 'markers'>, entries: StateEntry[]): AssetMarkerEvent[] {
  const markers = asset.markers ?? [];
  return entries.flatMap(({ layer, state, at }) =>
    markers.filter((marker) => marker.layer === layer && marker.state === state).map((marker) => ({ ...marker, at })));
}
