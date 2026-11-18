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
