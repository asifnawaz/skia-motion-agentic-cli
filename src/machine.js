import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bundleModule } from './rig.js';
import { fail } from './util.js';

import { isObj, SCHEMA, validateMachine } from '../runtime/machine-schema.js';

export { SCHEMA, VALUE_TYPES, BINDS, LOOPS, EASES, OPS, HIT_KINDS, MAX_CHANGES, validateMachine } from '../runtime/machine-schema.js';

/** Where the machine file of `name` lives: beside Root.tsx or in <project>/src, as the rig does. */
export const machineFile = (cfg, name) =>
  [dirname(cfg.root), join(cfg.projectDir, 'src')].map((d) => join(d, `${name}.machine.json`)).find(existsSync);

/** Where `<Name>.clips.ts` lives, beside the machine file's folders. */
export const clipsFile = (cfg, name) =>
  [dirname(cfg.root), join(cfg.projectDir, 'src')].flatMap((d) => ['ts', 'tsx'].map((e) => join(d, `${name}.clips.${e}`))).find(existsSync);

/**
 * Bundle and import `<Name>.clips.ts`: it exports `clips`, each `{ms, play(localMs) => {channels, parts?}}`.
 * Returns null when there is no clips file.
 */
export const loadClips = (cfg, name) => {
  const file = clipsFile(cfg, name);
  if (!file) return null;
  const mod = bundleModule(cfg, file, `${name}.clips.cjs`);
  const clips = mod.clips;
  if (!isObj(clips)) fail(`${file} does not export clips`, 'export const clips = { idle: { ms: 1000, play(ms) { \'worklet\'; return { channels: {...} }; } } }');
  for (const [n, c] of Object.entries(clips)) {
    if (!isObj(c) || typeof c.play !== 'function' || !(typeof c.ms === 'number' && c.ms > 0)) {
      fail(`clip "${n}" in ${file} is not {ms, play}`, 'each clip is { ms: <length in ms>, play(localMs) { \'worklet\'; return { channels } } }');
    }
  }
  return { file, clips };
};

/** Read and parse `<Name>.machine.json`, failing with a hint when it is missing or not JSON. */
export const readMachine = (file) => {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    fail(`cannot read ${file}`, 'check the path');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`${file} is not JSON: ${e.message}`, 'fix the syntax; every key and string takes double quotes');
  }
};

/**
 * `<Name> --machine`: the machine judged and its graph per layer, as one document. `ok` is false when any problem is
 * found; warnings do not change `ok`.
 * @param {*} cfg
 * @param {string} name
 * @param {{clips?: Record<string, {ms: number}>, clipNames?: string[]}} [opts]
 */
export const machineCommand = (cfg, name, { clips, clipNames = clips && Object.keys(clips) } = {}) => {
  const file = machineFile(cfg, name);
  if (!file) fail(`no ${name}.machine.json`, `write src/${name}.machine.json with "schema": "${SCHEMA}" (skac docs machine)`);
  const m = readMachine(file);
  const { problems, warnings, graphs = [] } = validateMachine(m, { clips, clipNames });
  const values = Object.fromEntries(Object.entries((isObj(m) && isObj(m.values) && m.values) || {}).map(([n, v]) => [n, { type: v?.type, bind: v?.bind || 'in', ...(v?.default !== undefined ? { default: v.default } : {}) }]));
  const doc = {
    ok: problems.length === 0,
    name,
    file,
    schema: isObj(m) ? m.schema : undefined,
    values,
    layers: graphs.map((g) => ({
      name: g.name, states: g.names, entry: g.entryTargets, reachable: g.reachable, unreachable: g.unreachable,
      dead_ends: g.deadEnds, zero_time_cycles: g.zeroTimeCycles,
    })),
    clips_checked: Boolean(clipNames),
    problems,
    warnings,
  };
  if (!doc.ok) {
    doc.error = `${problems.length} problem${problems.length === 1 ? '' : 's'} in ${name}.machine.json`;
    doc.hint = problems[0].hint;
  }
  return doc;
};
