const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode a validated base64 string on Node, Hermes, or the web. */
export function decodeBase64(encoded: string): Uint8Array {
  const bytes = new Uint8Array(encoded.length * 3 / 4);
  let length = 0;
  let bits = 0;
  let value = 0;
  for (const char of encoded) {
    if (char === '=') break;
    value = (value << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[length++] = (value >>> bits) & 255;
    }
  }
  return bytes.subarray(0, length);
}

export function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    chunk += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | (b >> 4)]! +
      (i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)]! : '=') +
      (i + 2 < bytes.length ? ALPHABET[c & 63]! : '=');
    if (chunk.length >= 8192) {
      chunks.push(chunk);
      chunk = '';
    }
  }
  return chunks.join('') + chunk;
}
