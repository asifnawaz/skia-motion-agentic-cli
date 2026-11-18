import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fail } from './util.js';
import { PACKAGE_ROOT, shown } from './docs.js';
import { writeManifest } from './update.js';
import { BUILTIN_LIBS, builtinFiles, libFiles, readUserLibs, resolveLibs } from './libs.js';
import { loadTypeScript } from './lint.js';

const next = (name) => ['npm install', `skac ${name} --verify`, `skac ${name} --render`];

const files = (dir, base = dir, out = []) => {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, base, out);
    else out.push(relative(base, p).split('\\').join('/'));
  }
  return out;
};

/** Copy a template tree into `dir`. Refuses a non-empty directory unless `force`. Installs nothing. */
const copyTree = (src, dir, force) => {
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length && !force) {
    fail(`${shown(target)} is not empty`, 'pick an empty directory or pass --force to overwrite files of the same name');
  }
  const written = [];
  for (const f of files(src)) {
    mkdirSync(join(target, f, '..'), { recursive: true });
    copyFileSync(join(src, f), join(target, f));
    written.push(f);
  }
  return { target, written };
};

/** Every new project gets the motion engine and face templates in src/motion/, so `docs motion/skill` works without the package path. */
const withMotion = (target, force) => {
  const src = join(PACKAGE_ROOT, 'templates', 'motion');
  if (!existsSync(src)) return [];
  const dest = join(target, 'src', 'motion');
  const written = [];
  // clock.app.ts needs react-native-reanimated, which a render project does not have; it stays in the package for apps.
  for (const f of files(src).filter((x) => x !== 'clock.app.ts')) {
    const to = join(dest, f);
    if (existsSync(to) && !force) continue;
    mkdirSync(join(to, '..'), { recursive: true });
    copyFileSync(join(src, f), to);
    written.push(`src/motion/${f}`);
  }
  return written;
};

/**
 * Write the libs into the new project: the built-in ones (onetake) fetched and verified, and the user's own by path. `libs` is the user's
 * default map (name -> path); a path there overrides a built-in of that name, so that name needs no network. The paths are recorded in the
 * project's skia-motion.json (as the user wrote them, `~` kept; a relative path there is relative to the user's libs file, so it is stored absolute).
 */
const withLibs = (target, libs, fetcher) => {
  const names = Object.keys(libs);
  const resolved = names.length ? resolveLibs(libs, resolve(target)) : {};
  if (names.length) {
    const cfgPath = join(target, 'skia-motion.json');
    const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
    cfg.libs = Object.fromEntries(names.map((n) => [n, libs[n].startsWith('~') ? libs[n] : resolved[n]]));
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  }
  const ts = loadTypeScript({ projectDir: target });
  const written = [];
  const put = (files) => {
    for (const [path, content] of files) {
      mkdirSync(join(target, path, '..'), { recursive: true });
      writeFileSync(join(target, path), content);
      written.push(path);
    }
  };
  for (const n of names) put(libFiles(ts, n, resolved[n]));
  for (const n of Object.keys(BUILTIN_LIBS).filter((x) => !names.includes(x))) put(builtinFiles(ts, n, { projectDir: target, fetcher }));
  return { written, resolved };
};

/** `create [dir]`: scaffold a project from templates/init, plus the motion templates. */
export const createProject = (dir = '.', { force = false, libs = readUserLibs(), fetcher } = {}) => {
  const src = join(PACKAGE_ROOT, 'templates', 'init');
  if (!existsSync(src)) fail('templates/init is missing from this package', 'reinstall skia-motion-agentic-cli');
  const { target, written } = copyTree(src, dir, force);
  const lib = withLibs(target, libs, fetcher);
  const all = [...written, ...withMotion(target, force), ...lib.written];
  writeManifest(target, all, lib.resolved);
  return { ok: true, dir: shown(target), files: all, next: next('Character') };
};

const sampleList = () => {
  const dir = join(PACKAGE_ROOT, 'templates', 'samples');
  const out = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (!statSync(p).isDirectory()) continue;
      let description = '';
      const meta = join(p, 'sample.json');
      if (existsSync(meta)) description = JSON.parse(readFileSync(meta, 'utf8')).description || '';
      const own = files(p).filter((f) => f !== 'sample.json');
      // A sample with no files of its own is the init template (the default `character`).
      const src = own.length ? p : join(PACKAGE_ROOT, 'templates', 'init');
      out.push({ name, description, files: own.length ? own : files(src), _src: src });
    }
  }
  if (!out.some((s) => s.name === 'character')) {
    const p = join(PACKAGE_ROOT, 'templates', 'init');
    if (existsSync(p)) out.unshift({ name: 'character', description: 'A runnable project with one character composition that reacts to tap and correct events.', files: files(p), _src: p });
  }
  return out;
};

/** `samples` lists bundled examples; `samples <name> [dir]` copies one. */
export const samples = (name, dir, { force = false, libs = readUserLibs(), fetcher } = {}) => {
  const list = sampleList();
  if (!name) return { ok: true, samples: list.map(({ _src, ...s }) => s), next: ['skac samples character ./my-motion'] };
  const s = list.find((x) => x.name === name);
  if (!s) fail(`no sample ${JSON.stringify(name)}`, `samples: ${list.map((x) => x.name).join(', ')}`);
  const { target, written } = copyTree(s._src, dir || name, force);
  const lib = withLibs(target, libs, fetcher);
  const all = [...written.filter((f) => f !== 'sample.json'), ...withMotion(target, force), ...lib.written];
  writeManifest(target, all, lib.resolved);
  return { ok: true, sample: name, dir: shown(target), files: all, next: next(name[0].toUpperCase() + name.slice(1)) };
};
