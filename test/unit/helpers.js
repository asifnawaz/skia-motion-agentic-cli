import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
