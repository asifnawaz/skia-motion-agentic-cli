import { decodeBase64, encodeBase64 } from './base64';

export type MotionAssetData = string | Uint8Array;
export type ResourceBytes = { readonly mime: string; readonly bytes: Uint8Array };
export type AssetResource = string | ResourceBytes;

export function isResourceBytes(value: unknown): value is ResourceBytes {
  return isRecord(value) && typeof value.mime === 'string' && value.bytes instanceof Uint8Array;
}

const HEADER_SIZE = 12;
const MAGIC = 0x534b4d4f; // SKMO
const VERSION = 1;
const MAX_RESOURCES = 4096;
const RESOURCE_KEYS = ['images', 'fonts', 'audio'] as const;
type ResourceKind = typeof RESOURCE_KEYS[number];
type SizeBreakdown = Record<ResourceKind | 'scene', number>;
type MapResource = (value: unknown, kind: ResourceKind) => unknown;
const RESOURCE_MIMES = new Set([
  'image/png', 'image/webp', 'font/ttf', 'font/otf', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac',
]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(message: string): never {
  throw new Error(`invalid SKMO asset: ${message}`);
}

export function isBinaryAsset(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) === MAGIC;
}

export function decodeAssetText(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // Older React Native hosts may have no TextDecoder.
  const chunks: string[] = [];
  let chunk = '';
  for (const byte of bytes) {
    chunk += byte < 128 && byte !== 37 ? String.fromCharCode(byte) : '%' + byte.toString(16).padStart(2, '0');
    if (chunk.length >= 8192) {
      chunks.push(chunk);
      chunk = '';
    }
  }
  chunks.push(chunk);
  return decodeURIComponent(chunks.join('')).replace(/^\uFEFF/, '');
}

function mapResources(value: unknown, map: MapResource): unknown {
  if (!isRecord(value)) return value;
  const result = { ...value };
  for (const key of RESOURCE_KEYS) {
    const resources = value[key];
    if (isRecord(resources)) {
      result[key] = Object.fromEntries(Object.entries(resources).map(([name, resource]) => [name, map(resource, key)]));
    }
  }
  return result;
}

export function mapFileResources(value: unknown, map: MapResource): unknown {
  const file = mapResources(value, map);
  if (isRecord(file) && file.schema === 'skac.bundle/1' && isRecord(file.artboards)) {
    file.artboards = Object.fromEntries(Object.entries(file.artboards).map(([name, board]) => [name, mapResources(board, map)]));
  }
  return file;
}

export function resourceDataUri(resource: AssetResource, cache?: Map<ResourceBytes, string>): string {
  if (typeof resource === 'string') return resource;
  const cached = cache?.get(resource);
  if (cached !== undefined) return cached;
  const uri = `data:${resource.mime};base64,${encodeBase64(resource.bytes)}`;
  cache?.set(resource, uri);
  return uri;
}

export function decodeBinaryAsset(bytes: Uint8Array, parseJSON: (text: string) => unknown): unknown {
  if (bytes.length < HEADER_SIZE) invalid('truncated header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== VERSION) invalid(`unsupported container version ${view.getUint8(4)}`);
  if (view.getUint8(5) || view.getUint16(6)) invalid('unsupported header flags');
  const manifestSize = view.getUint32(8, true);
  const manifestEnd = HEADER_SIZE + manifestSize;
  if (!manifestSize || manifestEnd > bytes.length) invalid('manifest length exceeds file bounds');
  const manifest = parseJSON(decodeAssetText(bytes.subarray(HEADER_SIZE, manifestEnd)));
  if (!isRecord(manifest) || Object.keys(manifest).length !== 2 || !isRecord(manifest.asset) ||
      !Array.isArray(manifest.resources) || manifest.resources.length > MAX_RESOURCES) invalid('invalid manifest');

  let offset = manifestEnd;
  const resources: ResourceBytes[] = manifest.resources.map((entry: unknown) => {
    if (!Array.isArray(entry) || entry.length !== 2) invalid('invalid resource entry');
    const [mime, length] = entry;
    if (!RESOURCE_MIMES.has(mime) || !Number.isSafeInteger(length) || length <= 0 || length > bytes.length - offset) {
      invalid('resource type or length is invalid');
    }
    const resource = { mime, bytes: bytes.subarray(offset, offset + length) };
    offset += length;
    return resource;
  });
  if (offset !== bytes.length) invalid('unexpected trailing bytes');
  return mapFileResources(manifest.asset, (index) => {
    if (typeof index !== 'number' || !Number.isInteger(index) || !resources[index]) invalid('unknown resource index');
    return resources[index]!;
  });
}

/** The authoring CLI writes a validated legacy scene into an SKMO container. */
export function encodeBinaryAsset(file: unknown, encodeText: (text: string) => Uint8Array, limit: number) {
  const uriIndices = new Map<string, number>();
  const payloadIndices = new Map<string, number[]>();
  const payload: ResourceBytes[] = [];
  const sizeBreakdown: SizeBreakdown = { scene: HEADER_SIZE, images: 0, fonts: 0, audio: 0 };
  const asset = mapFileResources(file, (resource, kind) => {
    if (typeof resource !== 'string') invalid('expected a data URI to pack');
    const known = uriIndices.get(resource);
    if (known !== undefined) return known;
    const header = /^data:([^;,]+);base64,/.exec(resource);
    if (!header || !RESOURCE_MIMES.has(header[1]!)) invalid('unsupported resource type');
    const mime = header[1]!;
    const bytes = decodeBase64(resource.slice(header[0].length));
    // Use FNV-1a to narrow candidates, then compare every byte before reusing an entry.
    let hash = 2166136261;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
    const key = `${mime}:${bytes.length}:${hash}`;
    const candidates = payloadIndices.get(key) ?? [];
    let index = candidates.find((candidate) => bytes.every((byte, i) => byte === payload[candidate]!.bytes[i]));
    if (index === undefined) {
      index = payload.length;
      if (index >= MAX_RESOURCES) invalid('too many resources');
      payload.push({ mime, bytes });
      sizeBreakdown[kind] += bytes.length;
      candidates.push(index);
      payloadIndices.set(key, candidates);
    }
    uriIndices.set(resource, index);
    return index;
  });
  const manifest = encodeText(JSON.stringify({ asset, resources: payload.map(({ mime, bytes }) => [mime, bytes.length]) }));
  sizeBreakdown.scene += manifest.length;
  const size = Object.values(sizeBreakdown).reduce((total, value) => total + value, 0);
  if (size > limit) throw Object.assign(new Error('packed asset exceeds 1 MiB'), { bytes: size, sizeBreakdown });
  const result = new Uint8Array(size);
  const view = new DataView(result.buffer);
  view.setUint32(0, MAGIC);
  view.setUint8(4, VERSION);
  view.setUint32(8, manifest.length, true);
  result.set(manifest, HEADER_SIZE);
  let offset = HEADER_SIZE + manifest.length;
  for (const resource of payload) {
    result.set(resource.bytes, offset);
    offset += resource.bytes.length;
  }
  return { data: result, sizeBreakdown };
}
