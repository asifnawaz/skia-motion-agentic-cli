/**
 * Format migrations for skac.asset and skac.bundle files. A file's format is its schema's major (skac.asset/1) and its optional root
 * minor (absent is 0). Each registered step upgrades a raw file, as parsed JSON with embedded resources as data URIs, from one format
 * to the next. Steps run in order; the result is checked with the current runtime before anything is written.
 *
 * No step is registered yet: every file so far is format 1.0, which every runtime of major 1 reads.
 */
export const MIGRATIONS = [];

export function fileFormat(file) {
  const match = typeof file?.schema === 'string' ? /^skac\.(asset|bundle)\/(\d+)$/.exec(file.schema) : null;
  if (!match) throw new Error('not a skac.asset or skac.bundle file');
  const minor = Number.isInteger(file.minor) ? file.minor : 0;
  return { kind: match[1], major: Number(match[2]), minor };
}

export const formatLabel = ({ major, minor }) => `${major}.${minor}`;

export function parseFormat(text) {
  const match = /^(\d+)\.(\d+)$/.exec(String(text));
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

const older = (a, b) => a.major < b.major || (a.major === b.major && a.minor < b.minor);

/** Every path whose value differs between two JSON values, up to a limit, for a reviewer to read. */
export function changedPaths(before, after, at = '', out = [], limit = 200) {
  if (out.length >= limit) return out;
  const object = (value) => value !== null && typeof value === 'object';
  if (!object(before) || !object(after) || Array.isArray(before) !== Array.isArray(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push(at || '(root)');
    return out;
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    changedPaths(before[key], after[key], Array.isArray(before) ? `${at}[${key}]` : at ? `${at}.${key}` : key, out, limit);
  }
  return out;
}

/**
 * Upgrade a raw file to `target` (the CLI's current format by default) through the registered steps. Returns the new file, the steps
 * taken and the paths they changed; throws when the file is newer than the target or a step is missing.
 */
export function migrateFile(file, { target, registry = MIGRATIONS }) {
  const from = fileFormat(file);
  if (older(target, from)) {
    throw new Error(`this file is format ${formatLabel(from)}, newer than ${formatLabel(target)}: update skia-motion-agentic-cli`);
  }
  let format = from;
  let next = structuredClone(file);
  const steps = [];
  while (older(format, target)) {
    const step = registry.find((candidate) => candidate.from.major === format.major && candidate.from.minor === format.minor);
    if (!step) throw new Error(`no migration from format ${formatLabel(format)}: update skia-motion-agentic-cli`);
    next = step.migrate(structuredClone(next));
    const reached = fileFormat(next);
    if (reached.major !== step.to.major || reached.minor !== step.to.minor) {
      throw new Error(`migration ${formatLabel(step.from)} to ${formatLabel(step.to)} produced format ${formatLabel(reached)}`);
    }
    steps.push({ from: formatLabel(format), to: formatLabel(reached), title: step.title });
    format = reached;
  }
  return { file: next, from: formatLabel(from), to: formatLabel(format), steps, changes: changedPaths(file, next) };
}
