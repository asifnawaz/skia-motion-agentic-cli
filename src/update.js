import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { run } from './util.js';
import { PACKAGE_ROOT } from './docs.js';
import { BUILTIN_LIBS, builtinFiles, libFiles, libPaths, readUserLibs, resolveLibs } from './libs.js';
import { loadTypeScript } from './lint.js';

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

/**
 * The files update manages, as project path -> a function giving the wanted bytes: src/motion/* (as withMotion copies, minus clock.app.ts),
 * AGENTS.md, CLAUDE.md, and the three files of each lib in `libs` (name -> absolute path; built on first use, a missing path is an error with a hint).
 */
const managed = (libs = {}, projectDir = '.', fetcher) => {
  const map = new Map();
  const motion = join(PACKAGE_ROOT, 'templates', 'motion');
  if (existsSync(motion)) for (const f of walk(motion).filter((x) => x !== 'clock.app.ts')) map.set(`src/motion/${f}`, () => readFileSync(join(motion, f)));
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const p = join(PACKAGE_ROOT, 'templates', 'init', f);
    if (existsSync(p)) map.set(f, () => readFileSync(p));
  }
  // Built-in libs (onetake) come by fetch unless a local path overrides that name; the others come from their path.
  const names = new Set([...Object.keys(BUILTIN_LIBS), ...Object.keys(libs)]);
  for (const name of names) {
    const src = libs[name];
    let built;
    for (const path of libPaths(name, !src)) {
      map.set(path, () => {
        const ts = loadTypeScript({ projectDir });
        built ??= src ? libFiles(ts, name, src) : builtinFiles(ts, name, { projectDir, fetcher });
        return Buffer.from(built.get(path));
      });
    }
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

const fileState = (projectDir, path, wantHash, manifest, force) => {
  const to = join(projectDir, path);
  if (!existsSync(to)) return 'added';
  const have = sha(readFileSync(to));
  if (have === wantHash) return 'same';
  return manifest?.[path] === have || force ? 'updated' : 'kept-edited';
};

/** The `update --check` state of a managed project path, without writing files or looking up versions. */
export const managedFileCheck = (projectDir) => {
  const manifest = readManifest(projectDir);
  const files = managed({}, projectDir);
  return (path) => {
    const read = files.get(path);
    return read ? fileState(projectDir, path, sha(read()), manifest, false) : 'unmanaged';
  };
};

const saveManifest = (projectDir, manifest) => {
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(join(projectDir, MANIFEST), JSON.stringify(sorted, null, 2) + '\n');
};

/**
 * Record the sha256 of each listed project file (paths relative to `projectDir`) in `.skac-files.json`,
 * keeping earlier entries. Call it right after `create` or `samples` copied the files, while they still equal the template.
 */
export const writeManifest = (projectDir, files, libs = {}) => {
  const manifest = readManifest(projectDir) || {};
  const known = managed(libs, projectDir);
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
export const update = (cfg, { force = false, check = false, runner = run, fetcher } = {}) => {
  const projectDir = cfg.projectDir;
  const manifest = readManifest(projectDir);
  const next = { ...(manifest || {}) };
  const files = [];

  // A built-in lib's override in the user's libs file counts here too, as it does at create.
  const user = resolveLibs(readUserLibs(), projectDir, 'the user libs file');
  const overrides = Object.fromEntries(Object.entries(user).filter(([n]) => n in BUILTIN_LIBS));
  for (const [path, read] of managed({ ...overrides, ...cfg.libs }, projectDir, fetcher)) {
    const want = read();
    const wantHash = sha(want);
    const state = fileState(projectDir, path, wantHash, manifest, force);
    files.push({ path, state });
    if (state === 'kept-edited') continue;
    next[path] = wantHash;
    if (check || state === 'same') continue;
    const to = join(projectDir, path);
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
