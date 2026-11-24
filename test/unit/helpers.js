import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { deflateSync } from 'node:zlib';

// PNG's CRC-32 by table: zlib.crc32 arrived in Node 20.15 and 22.2, and the package supports Node 18.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Scratch lives inside the copy (never /tmp). `node --test` runs each test file in its own process, so one
// folder per process is one folder per test file: no file deletes another's scratch. Removed when the process exits.
export const SCRATCH = process.env.SKIA_MOTION_SCRATCH || join(dirname(fileURLToPath(import.meta.url)), '..', '.scratch');

let own = null;
const ownDir = () => {
  if (own) return own;
  mkdirSync(SCRATCH, { recursive: true });
  own = mkdtempSync(join(SCRATCH, `p${process.pid}-`));
  process.on('exit', () => rmSync(own, { recursive: true, force: true }));
  return own;
};

/** A fresh folder inside this test file's own scratch folder. */
export const tmp = (prefix = 'skac-') => mkdtempSync(join(ownDir(), prefix));
export const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

// Bundle together so re-exports and their original modules share function identities.
export const loadModules = (entries, stubs = {}) => {
  const contents = Object.entries(entries).map(([name, file]) => `export * as ${name} from ${JSON.stringify(file)};`).join('\n');
  const { outputFiles: [output] } = buildSync({
    stdin: { contents, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node18', external: Object.keys(stubs),
  });
  const module = { exports: {} };
  const requireStub = (name) => {
    if (!Object.hasOwn(stubs, name)) throw new Error(`Unexpected test module import ${name}`);
    return stubs[name];
  };
  new Function('module', 'exports', 'require', output.text)(module, module.exports, requireStub);
  return module.exports;
};

// A 12 x 12 PNG: a solid disc of radius 4 in the middle, clear around it, so the drawn part is the middle 8 x 8.
export function coinPng() {
  const size = 12;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = y * (size * 4 + 1) + 1 + x * 4;
      const inside = Math.hypot(x + 0.5 - 6, y + 0.5 - 6) <= 4;
      raw.set(inside ? [230, 180, 60, 255] : [230, 180, 60, 0], at); // clear pixels keep the coin's colour, so a scaled edge has no dark fringe
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
