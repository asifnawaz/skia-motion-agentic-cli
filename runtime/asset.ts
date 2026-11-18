import { validateMachine } from './machine-schema.js';
import { EASE_IN, EASE_IN_OUT, EASE_OUT } from '../templates/motion/motion';
import type { Clips, Machine, StateEntry } from '../templates/motion/machine';
import type { AssetAnchor } from './asset-layout';
import { imageSize } from './asset-image';

export const ASSET_SCHEMA = 'skac.asset/1';
export const MAX_ASSET_BYTES = 1024 * 1024;
export const MAX_FEATHER = 64;

type Scalar = number | string;
type Ease = 'linear' | 'in' | 'out' | 'inOut' | 'hold';
type Key = readonly [ms: number, value: number, ease?: Ease];
type Track = readonly Key[];
export type PathCommand =
  | readonly [op: 'M' | 'L', x: Scalar, y: Scalar]
  | readonly [op: 'Q', controlX: Scalar, controlY: Scalar, x: Scalar, y: Scalar]
  | readonly [op: 'C', control1X: Scalar, control1Y: Scalar, control2X: Scalar, control2Y: Scalar, x: Scalar, y: Scalar]
  | readonly [op: 'Z'];
type Shade = string | { kind: 'radial'; x: Scalar; y: Scalar; radius: Scalar; colors: readonly [string, string] };

type Group = {
  kind: 'group'; x?: Scalar; y?: Scalar; scaleX?: Scalar; scaleY?: Scalar; rotation?: Scalar;
  anchor?: AssetAnchor;
  clip?: readonly PathCommand[];
  points?: Readonly<Record<string, { x: Scalar; y: Scalar }>>;
  children: readonly AssetNode[];
};
type Shape = { fill: Shade; opacity?: Scalar; feather?: Scalar } & (
  | { kind: 'ellipse'; x: Scalar; y: Scalar; width: Scalar; height: Scalar }
  | { kind: 'roundRect'; x: Scalar; y: Scalar; width: Scalar; height: Scalar; radius: Scalar }
  | { kind: 'path'; commands: readonly PathCommand[] }
);

type ImageNode = {
  kind: 'image'; image: string; opacity?: Scalar;
  x: Scalar; y: Scalar; width: Scalar; height: Scalar;
};

export type AssetNode = Group | Shape | ImageNode;
export type AssetMarker = { name: string; layer: string; state: string };
export type AssetMarkerEvent = AssetMarker & { at: number };
export type AssetAttachment = { from: string; to: string; maxDistance: number };
export type MotionAsset<M extends Machine = Machine> = {
  schema: typeof ASSET_SCHEMA;
  name: string;
  artboard: { width: number; height: number; nodes: readonly AssetNode[] };
  channels: Readonly<Record<string, number>>;
  images?: Readonly<Record<string, string>>;
  clips: Readonly<Record<string, { ms: number; reducedAt?: number; tracks: Readonly<Record<string, Track>> }>>;
  machine: M;
  markers?: readonly AssetMarker[];
  attachments?: readonly AssetAttachment[];
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const PATH_ARGUMENTS: Record<string, number> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
const EASES = ['linear', 'in', 'out', 'inOut', 'hold'];
const RESERVED_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

function invalid(at: string, message: string): never {
  throw new Error(`${at}: ${message}`);
}

function record(value: unknown, at: string, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(at, 'expected an object');
  const data = value as Record<string, unknown>;
  if (keys) for (const key of Object.keys(data)) if (!keys.includes(key)) invalid(`${at}.${key}`, 'unknown field');
  return data;
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
  points: Set<string>;
};

function checkNode(value: unknown, at: string, context: NodeValidation, depth: number): void {
  const { channels, images, points } = context;
  const node = record(value, at);
  if (node.kind === 'group') {
    record(node, at, ['kind', 'children', 'x', 'y', 'scaleX', 'scaleY', 'rotation', 'anchor', 'clip', 'points']);
    for (const key of ['x', 'y', 'scaleX', 'scaleY', 'rotation']) {
      if (node[key] !== undefined) scalar(node[key], `${at}.${key}`, channels);
    }
    if (node.points !== undefined) {
      for (const [name, rawPoint] of Object.entries(record(node.points, `${at}.points`))) {
        const key = `${at}.points.${name}`;
        identifier(name, key);
        if (points.has(name)) invalid(key, 'duplicate point name');
        points.add(name);
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
    if (depth >= 16) invalid(at, 'groups are nested more than 16 levels');
    list(node.children, `${at}.children`, 256).forEach((child, i) => checkNode(child, `${at}.children[${i}]`, context, depth + 1));
    return;
  }
  if (node.kind === 'image') {
    record(node, at, ['kind', 'image', 'x', 'y', 'width', 'height', 'opacity']);
    if (typeof node.image !== 'string' || !Object.hasOwn(images, node.image)) invalid(`${at}.image`, 'expected a name from images');
    for (const key of ['x', 'y']) scalar(node[key], `${at}.${key}`, channels);
    for (const key of ['width', 'height']) scalar(node[key], `${at}.${key}`, channels, 0);
    if (node.opacity !== undefined) scalar(node.opacity, `${at}.opacity`, channels, 0, 1);
    return;
  }
  if (node.kind === 'path') {
    record(node, at, ['kind', 'fill', 'opacity', 'feather', 'commands']);
    checkPath(node.commands, `${at}.commands`, channels);
  } else if (node.kind === 'ellipse' || node.kind === 'roundRect') {
    const keys = ['kind', 'fill', 'opacity', 'feather', 'x', 'y', 'width', 'height'];
    if (node.kind === 'roundRect') keys.push('radius');
    record(node, at, keys);
    for (const key of ['x', 'y', 'width', 'height']) scalar(node[key], `${at}.${key}`, channels, key === 'x' || key === 'y' ? undefined : 0);
    if (node.kind === 'roundRect') scalar(node.radius, `${at}.radius`, channels, 0);
  } else {
    invalid(`${at}.kind`, 'expected ellipse, roundRect, path, image or group');
  }
  if (node.opacity !== undefined) scalar(node.opacity, `${at}.opacity`, channels, 0, 1);
  if (node.feather !== undefined) scalar(node.feather, `${at}.feather`, channels, 0, MAX_FEATHER);
  if (typeof node.fill === 'string') {
    color(node.fill, `${at}.fill`);
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

function validateAsset(value: unknown): MotionAsset {
  const data = record(value, 'asset', ['schema', 'name', 'artboard', 'channels', 'clips', 'machine', 'markers', 'images', 'attachments']);
  if (data.schema !== ASSET_SCHEMA) invalid('asset.schema', `this player reads ${ASSET_SCHEMA}`);
  identifier(data.name, 'asset.name');
  const channels = record(data.channels, 'channels');
  for (const [name, value] of Object.entries(channels)) {
    identifier(name, `channels.${name}`);
    number(value, `channels.${name}`);
  }
  const images = data.images === undefined ? {} : record(data.images, 'images');
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
  const nodes = list(artboard.nodes, 'artboard.nodes', 256);
  if (!nodes.length) invalid('artboard.nodes', 'add at least one shape');
  const context = { channels, images, points: new Set<string>() };
  nodes.forEach((node, i) => checkNode(node, `artboard.nodes[${i}]`, context, 0));
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
  const machine = record(data.machine, 'machine');
  if (machine.clocks !== undefined || machine.hits !== undefined) invalid('machine', 'this asset version uses frame clocks and host input');
  list(machine.layers, 'machine.layers', 32).forEach((value, i) => {
    const at = `machine.layers[${i}]`;
    const layer = record(value, at);
    if (Object.keys(record(layer.states, `${at}.states`)).length > 128) invalid(`${at}.states`, 'maximum of 128 states per layer');
    if (layer.transitions !== undefined) list(layer.transitions, `${at}.transitions`, 512);
  });
  const checked = validateMachine(machine, { clips: clips as MotionAsset['clips'] });
  if (checked.problems.length) {
    const { where, error, hint } = checked.problems[0]!;
    invalid(where ? `machine.${where}` : 'machine', `${error}. ${hint}`);
  }
  const typed = data as MotionAsset;
  const names = new Set();
  if (data.markers !== undefined) {
    list(data.markers, 'markers', 256).forEach((item, i) => {
      const at = `markers[${i}]`;
      const marker = record(item, at, ['name', 'layer', 'state']);
      const name = identifier(marker.name, `${at}.name`);
      if (names.has(name)) invalid(`${at}.name`, 'duplicate marker name');
      names.add(name);
      const layer = typed.machine.layers.find((layer) => layer.name === marker.layer);
      const state = identifier(marker.state, `${at}.state`);
      if (!layer || !Object.hasOwn(layer.states, state)) invalid(at, 'unknown layer or state');
    });
  }
  return typed;
}

/** Decode the same data file on a React Native JS thread and in the CLI. */
export function parseAsset(text: string): MotionAsset {
  if (typeof text !== 'string' || text.length > MAX_ASSET_BYTES) invalid('asset', 'expected a JSON asset of at most 1 MiB');
  const bytes = encodeURI(text).replace(/%[0-9A-F]{2}/g, 'x').length;
  if (bytes > MAX_ASSET_BYTES) invalid('asset', 'expected a JSON asset of at most 1 MiB');
  const decoded: unknown = JSON.parse(text, (key, value: unknown) => {
    if (RESERVED_KEYS.has(key)) invalid(key, 'reserved field name');
    if (typeof value === 'number' && !Number.isFinite(value)) invalid(key, 'expected a finite number');
    return value;
  });
  return validateAsset(decoded);
}

/** Image names used by the drawing. Unreferenced library entries can be omitted from playback. */
export function usedAssetImages(nodes: readonly AssetNode[], names = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.kind === 'image') names.add(node.image);
    else if (node.kind === 'group') usedAssetImages(node.children, names);
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
export function assetClips(asset: MotionAsset): Clips {
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
