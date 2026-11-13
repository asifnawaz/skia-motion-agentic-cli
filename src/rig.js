import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { registrations } from './project.js';
import { fail } from './util.js';

const EXTERNAL = ['react', 'react-dom', 'remotion', '@shopify/react-native-skia', '@remotion/*'];

/**
 * esbuild from the project, then through @remotion/cli -> @remotion/bundler -> esbuild (pnpm hides it),
 * then skac's own copy. Returns the module or null.
 */
const findEsbuild = (projectDir) => {
  const tries = [
    () => createRequire(join(projectDir, 'package.json'))('esbuild'),
    () => {
      const fromProject = createRequire(join(projectDir, 'package.json'));
      const cli = fromProject.resolve('@remotion/cli/package.json');
      const bundler = createRequire(cli).resolve('@remotion/bundler/package.json');
      return createRequire(bundler)('esbuild');
    },
    () => createRequire(import.meta.url)('esbuild'),
  ];
  for (const t of tries) {
    try {
      const mod = t();
      if (mod && typeof mod.buildSync === 'function') return mod;
    } catch {
      /* try the next place */
    }
  }
  return null;
};

/** The source file of the component registered as `name`, or undefined when Root.tsx cannot say. */
const componentOf = (cfg, name) => {
  try {
    return registrations(cfg).find((r) => r.id === name)?._abs;
  } catch {
    return undefined;
  }
};

/**
 * Where the rig lives: `<Name>.rig.ts` beside Root.tsx, else in <project>/src, else beside the component's own file,
 * so `Combo60` and `Combo120` registered on the `Combo` component share Combo.rig.ts.
 */
const findRigFile = (cfg, name, componentFile) => {
  const dirs = [dirname(cfg.root), join(cfg.projectDir, 'src')];
  const candidates = [];
  for (const d of dirs) for (const ext of ['ts', 'tsx']) candidates.push(join(d, `${name}.rig.${ext}`));
  if (componentFile) for (const ext of ['ts', 'tsx']) candidates.push(componentFile.replace(/\.[jt]sx?$/, `.rig.${ext}`));
  const found = candidates.find((p) => existsSync(p));
  if (!found) fail(`no rig file for ${name}`, `create ${candidates[0]} exporting meta and rig(ms) (skac docs blind)`);
  return found;
};

/**
 * Bundle `<Name>.rig.ts` and import it. Synchronous.
 * @param {{projectDir: string, root: string, out: string}} cfg
 * @param {string} name composition name
 * @param {string} [componentFile] the component's source file; defaults to the one Root.tsx registers as `name`
 * @returns {{rig: Function, meta: object, file: string}} `file` is the source file
 */
export const loadRig = (cfg, name, componentFile = componentOf(cfg, name)) => {
  const file = findRigFile(cfg, name, componentFile);
  const esbuild = findEsbuild(cfg.projectDir);
  if (!esbuild) fail('esbuild not found', 'run `npm install` in the project (Remotion brings esbuild)');
  const outfile = join(cfg.out, 'rig', `${name}.rig.cjs`);
  mkdirSync(dirname(outfile), { recursive: true });
  try {
    esbuild.buildSync({
      entryPoints: [file],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      external: EXTERNAL,
      absWorkingDir: cfg.projectDir,
      logLevel: 'silent',
    });
  } catch (e) {
    const errs = (e.errors || []).map((x) => `${x.location ? `${x.location.file}:${x.location.line} ` : ''}${x.text}`);
    fail(`could not bundle ${file}`, errs.slice(0, 3).join('; ') || e.message);
  }
  const require = createRequire(outfile);
  delete require.cache[outfile];
  const mod = require(outfile);
  if (typeof mod.rig !== 'function') fail(`${file} does not export rig(ms)`, 'export function rig(ms, events) { return { channels, parts } }');
  const m = mod.meta;
  if (!m || typeof m !== 'object' || !(m.fps > 0) || !(m.frames > 0)) {
    fail(`${file} does not export a valid meta`, 'export const meta = { fps, frames, width, height, scale, events }');
  }
  return { rig: mod.rig, meta: m, file };
};

/** Add one frame's values to `store` (name -> number[]); every name must appear on every frame. */
// A value the rig does not return on some sample is recorded as NaN, never thrown: runRules turns any NaN into a
// `skac/samples` error finding naming the channel or part and the first time. A name that first appears late is
// backfilled with NaN, so every array stays the grid's length. Only a value of the wrong type (a string) throws.
const push = (arr, v, i) => {
  while (arr.length < i) arr.push(NaN);
  arr.push(v);
};

const collect = (store, values, i, ms, what) => {
  for (const [n, v] of Object.entries(values || {})) {
    if (v !== undefined && typeof v !== 'number') fail(`${what} "${n}" is not a number at ${Math.round(ms)} ms`, 'channels are numbers');
    push((store[n] ??= []), v === undefined ? NaN : v, i);
  }
  for (const arr of Object.values(store)) if (arr.length === i) arr.push(NaN);
};

const FIELDS = ['x', 'y', 'w', 'h', 'rot'];

/**
 * The rules sample every rig on this one grid, whatever the composition's fps: the rig is a pure function of ms,
 * so the grid costs nothing, and a 30, 60 or 120 fps composition gets bit-identical samples and the same verdict.
 * 120 Hz is the fastest display a composition targets; every rule threshold is in ms or per-ms terms.
 */
export const GRID_HZ = 120;

/** How many grid samples cover the composition: its length in ms, at GRID_HZ. */
export const gridLength = (meta) => Math.round((meta.frames / meta.fps) * GRID_HZ);

const sampleOnce = (rig, meta, events, order) => {
  const dt = 1000 / GRID_HZ;
  const n = order.length;
  const channels = {};
  const parts = {};
  const slots = new Array(n);
  for (const i of order) slots[i] = rig(i * dt, events);
  for (let i = 0; i < n; i++) {
    const ms = i * dt;
    const out = slots[i] || {};
    collect(channels, out.channels || {}, i, ms, 'channel');
    for (const [n, p] of Object.entries(out.parts || {})) {
      const fields = Object.fromEntries(FIELDS.filter((f) => p && p[f] !== undefined).map((f) => [f, p[f]]));
      // x and y are always recorded, so a part without them shows as NaN rather than vanishing.
      collect((parts[n] ??= { x: [], y: [] }), { x: undefined, y: undefined, ...fields }, i, ms, `part "${n}" field`);
    }
    for (const store of Object.values(parts)) for (const arr of Object.values(store)) if (arr.length === i) arr.push(NaN);
  }
  return { channels, parts };
};

/**
 * Sample the rig on the GRID_HZ grid over the composition's length (meta.frames / meta.fps seconds).
 * `fps` in the result is the sampling rate (GRID_HZ), not the composition's. A second pass in reverse order
 * is kept as `recheck` (the determinism rule compares it, so state carried between calls shows up).
 * @param {Function} rig
 * @param {{fps: number, frames: number, events?: object[]}} meta
 * @param {{name: string, at: number}[]} [events] defaults to meta.events
 * @returns {{fps: number, t_ms: number[], channels: Record<string, number[]>, parts: Record<string, Record<string, number[]>>, recheck: object}}
 */
export const sampleRig = (rig, meta, events = meta.events) => {
  const n = gridLength(meta);
  const forward = Array.from({ length: n }, (_, i) => i);
  const first = sampleOnce(rig, meta, events, forward);
  const second = sampleOnce(rig, meta, events, forward.slice().reverse());
  return {
    fps: GRID_HZ,
    t_ms: forward.map((i) => (i * 1000) / GRID_HZ),
    channels: first.channels,
    parts: first.parts,
    recheck: second,
  };
};
