import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { run } from './util.js';
import { PACKAGE_ROOT } from './docs.js';

export const MANIFEST = '.skac-files.json';
export const PACKAGE_NAME = 'skia-motion-agentic-cli';
const LOOKUP_TIMEOUT_MS = 5000;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const walk = (dir, base = dir, out = []) => {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split('\\').join('/'));
  }
  return out;
};

/** The files update manages, as project path -> template file: src/motion/* (as withMotion copies, minus clock.app.ts), AGENTS.md, CLAUDE.md. */
const managed = () => {
  const map = new Map();
  const motion = join(PACKAGE_ROOT, 'templates', 'motion');
  if (existsSync(motion)) for (const f of walk(motion).filter((x) => x !== 'clock.app.ts')) map.set(`src/motion/${f}`, join(motion, f));
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const p = join(PACKAGE_ROOT, 'templates', 'init', f);
    if (existsSync(p)) map.set(f, p);
  }
  return map;
};

const readManifest = (projectDir) => {
  try {
    const m = JSON.parse(readFileSync(join(projectDir, MANIFEST), 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
};

const saveManifest = (projectDir, manifest) => {
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(join(projectDir, MANIFEST), JSON.stringify(sorted, null, 2) + '\n');
};

/**
 * Record the sha256 of each listed project file (paths relative to `projectDir`) in `.skac-files.json`,
 * keeping earlier entries. Call it right after `create` or `samples` copied the files, while they still equal the template.
 */
export const writeManifest = (projectDir, files) => {
  const manifest = readManifest(projectDir) || {};
  const known = managed();
  for (const f of files) {
    if (!known.has(f)) continue;
    const p = join(projectDir, f);
    if (existsSync(p)) manifest[f] = sha(readFileSync(p));
  }
  saveManifest(projectDir, manifest);
};

const installedVersion = () => JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

const newer = (a, b) => {
  const n = (v) => v.split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

/**
 * `update`: refresh the project's skac-provided files from the installed skac.
 * Replaces files the project never edited ("edited" = differs from the hash recorded in .skac-files.json),
 * keeps edited ones unless `force`, adds missing ones. `check` reports without writing.
 * `runner` replaces the npm lookup in tests.
 */
export const update = (cfg, { force = false, check = false, runner = run } = {}) => {
  const projectDir = cfg.projectDir;
  const manifest = readManifest(projectDir);
  const next = { ...(manifest || {}) };
  const files = [];

  for (const [path, tpl] of managed()) {
    const want = readFileSync(tpl);
    const wantHash = sha(want);
    const to = join(projectDir, path);
    let state;
    if (!existsSync(to)) state = 'added';
    else {
      const have = sha(readFileSync(to));
      if (have === wantHash) state = 'same';
      else if (manifest && manifest[path] === have) state = 'updated';
      else state = force ? 'updated' : 'kept-edited';
    }
    files.push({ path, state });
    if (state === 'kept-edited') continue;
    next[path] = wantHash;
    if (check || state === 'same') continue;
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, want);
  }

  if (!check && (manifest ? JSON.stringify(next) !== JSON.stringify(manifest) : true)) saveManifest(projectDir, next);

  const version = installedVersion();
  const doc = { ok: true, version, files };
  if (check) doc.check = true;
  const r = runner('npm', ['view', PACKAGE_NAME, 'version'], { timeout: LOOKUP_TIMEOUT_MS });
  const latest = r && r.code === 0 && !r.error ? r.stdout.trim() : '';
  if (/^\d+\.\d+\.\d+/.test(latest)) {
    doc.latest = latest;
    if (newer(latest, version)) doc.upgrade = `npm i -g ${PACKAGE_NAME}@latest`;
  }
  const kept = files.filter((f) => f.state === 'kept-edited').map((f) => f.path);
  if (kept.length) doc.hint = `${kept.length} edited file(s) kept; pass --force to replace them with the installed version`;
  return doc;
};
