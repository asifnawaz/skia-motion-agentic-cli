import { decodeBase64 } from './base64';
import { isResourceBytes } from './asset-binary';

/** Check the embedded image header before passing its bytes to a renderer. */
export function imageSize(uri: unknown): { width: number; height: number } | null {
  if (isResourceBytes(uri)) {
    return uri.mime.startsWith('image/') ? imageFileSize(uri.mime.slice(6), uri.bytes) : null;
  }
  if (typeof uri !== 'string') return null;
  const match = /^data:image\/(png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
  if (!match || match[0] !== uri || match[2]!.length % 4 !== 0) return null;
  const encoded = match[2]!;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const size = encoded.length * 3 / 4 - padding;
  const prefix = decodeBase64(encoded.slice(0, 40));
  const suffix = decodeBase64(encoded.slice(-20)).subarray(-12);
  return sizeFromParts(match[1]!, prefix, suffix, size);
}

/** Validate source artwork in the authoring CLI without encoding it to base64 first. */
export function imageFileSize(format: string, data: Uint8Array): { width: number; height: number } | null {
  return sizeFromParts(format, data.subarray(0, 30), data.subarray(-12), data.length);
}

function sizeFromParts(format: string, bytes: Uint8Array, tail: Uint8Array, size: number) {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === 'png') {
    if (size < 57 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(8) !== 13 || tag(12) !== 'IHDR') return null;
    const end = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    if (end.getUint32(0) !== 0 || end.getUint32(4) !== 0x49454e44 || end.getUint32(8) !== 0xae426082) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (format !== 'webp' || bytes.length < 25 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return null;
  const chunkSize = view.getUint32(16, true);
  if (view.getUint32(4, true) !== size - 8 || 20 + chunkSize + (chunkSize % 2) > size) return null;
  const chunkType = tag(12);
  if (chunkType === 'VP8X' && chunkSize === 10) {
    if (size === 30 || (bytes[20]! & 2) !== 0) return null;
    const word = (at: number) => bytes[at]! + 256 * bytes[at + 1]! + 65536 * bytes[at + 2]!;
    return { width: 1 + word(24), height: 1 + word(27) };
  }
  if (chunkType === 'VP8L' && chunkSize >= 5 && bytes[20] === 0x2f) {
    const size = view.getUint32(21, true);
    return { width: 1 + (size & 0x3fff), height: 1 + ((size >>> 14) & 0x3fff) };
  }
  if (chunkType === 'VP8 ' && chunkSize >= 10 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  return null;
}
