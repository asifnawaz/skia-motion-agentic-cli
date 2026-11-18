import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

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
