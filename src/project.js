import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fail, levenshteinNear, readText } from './util.js';
import { PACKAGE_ROOT, shown } from './docs.js';

const rel = (cfg, p) => `./${relative(cfg.projectDir, p)}`;
const lineCount = (text) => text.replace(/\n$/, '').split('\n').length;

const num = (expr) => (expr !== undefined && /^\d+(\.\d+)?$/.test(expr.trim()) ? Number(expr) : null);

/** Value of a JSX prop: `{...}` with nested braces, or "string". Returns raw text or undefined. */
const prop = (tag, name) => {
  const m = new RegExp(`\\b${name}=`).exec(tag);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  if (tag[i] === '"' || tag[i] === "'") return tag.slice(i + 1, tag.indexOf(tag[i], i + 1));
  if (tag[i] !== '{') return undefined;
  let depth = 0;
  const start = i + 1;
  for (; i < tag.length; i++) {
    if (tag[i] === '{') depth++;
    else if (tag[i] === '}' && --depth === 0) return tag.slice(start, i).trim();
  }
  return undefined;
};

const resolveImport = (rootDir, spec) => {
  const base = resolve(rootDir, spec);
  for (const ext of ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) if (existsSync(base + ext)) return base + ext;
  return null;
};

/** Read every `<Composition .../>` registered in the root file. */
export const registrations = (cfg) => {
  if (!existsSync(cfg.root)) fail(`root file not found: ${shown(cfg.root)}`, 'set "root" in skia-motion.json or pass --root');
  const text = readText(cfg.root);
  const imports = {};
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]/g)) {
    for (const n of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)) imports[n] = m[2];
  }
  const out = [];
  for (const m of text.matchAll(/<Composition\b([\s\S]*?)\/>/g)) {
    const tag = m[1];
    const id = prop(tag, 'id');
    const component = prop(tag, 'component');
    const spec = imports[component];
    const file = spec ? resolveImport(dirname(cfg.root), spec) : null;
    const frames = prop(tag, 'durationInFrames');
    out.push({
      id, component,
      width: num(prop(tag, 'width')), height: num(prop(tag, 'height')),
      fps: num(prop(tag, 'fps')), frames: num(frames),
      ...(num(frames) === null && frames ? { frames_expr: frames } : {}),
      file: file ? rel(cfg, file) : null,
      _abs: file,
    });
  }
  return out;
};

const strip = ({ _abs, ...r }) => r;

export const find = (cfg, name) => {
  const all = registrations(cfg);
  const hit = all.find((r) => r.id === name);
  if (!hit) {
    const near = levenshteinNear(name, all.map((r) => r.id));
    fail(`no composition ${JSON.stringify(name)} in ${shown(cfg.root)}`,
      'run `skac inspect` to list them, or `skac add <Name>`', near.length ? { did_you_mean: near } : {});
  }
  return hit;
};

export const compositions = (cfg) => {
  const list = registrations(cfg).map((r) => ({
    id: r.id, file: r.file, lines: r._abs ? lineCount(readText(r._abs)) : null,
  }));
  return { ok: true, root: rel(cfg, cfg.root), count: list.length, compositions: list };
};

export const inspect = (cfg, name) => {
  if (!name) return compositions(cfg);
  const r = find(cfg, name);
  const doc = { ok: true, ...strip(r) };
  if (r._abs) {
    const text = readText(r._abs);
    doc.lines = lineCount(text);
    doc.consts = [...text.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    doc.reads_events = /\bevents\b/.test(text);
    doc.props = doc.reads_events ? ['events'] : [];
    doc.events_handled = [...new Set([...text.matchAll(/\bname\s*===?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))];
  }
  doc.next = [
    `skac ${name} --verify`,
    `skac ${name} --screenshot --at=0.5,4.0 --sheet`,
    `skac ${name} --render`,
    `skac ${name} --commands "tap@4.0" --render`,
  ];
  return doc;
};

/** Add a composition file and register it in the root file. */
export const add = (cfg, name, { size = '390x867', fps = 60, frames = 480 } = {}) => {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name || '')) fail(`bad name ${JSON.stringify(name)}`, 'use PascalCase letters and digits, like Character');
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) fail(`--size must look like 390x867, got ${JSON.stringify(size)}`);
  const tmpl = join(PACKAGE_ROOT, 'templates', 'composition.tsx.tmpl');
  if (!existsSync(tmpl)) fail('templates/composition.tsx.tmpl is missing from this package', 'reinstall skia-motion');
  if (!existsSync(cfg.root)) fail(`root file not found: ${shown(cfg.root)}`, 'run `skac create` first or set "root"');
  const rigTmpl = join(PACKAGE_ROOT, 'templates', 'rig.ts.tmpl');
  if (!existsSync(rigTmpl)) fail('templates/rig.ts.tmpl is missing from this package', 'reinstall skia-motion');
  const file = join(dirname(cfg.root), `${name}.tsx`);
  const rigFile = join(dirname(cfg.root), `${name}.rig.ts`);
  if (existsSync(rigFile)) fail(`${shown(rigFile)} already exists`, 'pick another name');
  if (existsSync(file)) fail(`${shown(file)} already exists`, 'pick another name');
  let root = readFileSync(cfg.root, 'utf8');
  if (registrations(cfg).some((r) => r.id === name)) fail(`${name} is already registered`, 'pick another name');
  const lines = root.split('\n');
  const lastImport = lines.map((l) => /^import\b/.test(l)).lastIndexOf(true);
  const closeIdx = lines.lastIndexOf(lines.filter((l) => l.trim() === '</>' || l.trim().startsWith('</>')).pop() ?? '');
  if (lastImport < 0 || closeIdx < 0) fail('could not find the import block or the closing </> in the root file', 'add the import and <Composition> by hand');
  const tag = `  <Composition id="${name}" component={${name}} width={${m[1]}} height={${m[2]}} fps={${Number(fps)}} durationInFrames={${Number(frames)}} />`;
  lines.splice(closeIdx, 0, tag);
  lines.splice(lastImport + 1, 0, `import { ${name} } from './${name}';`);
  writeFileSync(file, readFileSync(tmpl, 'utf8').replaceAll('__NAME__', name));
  writeFileSync(rigFile, readFileSync(rigTmpl, 'utf8').replaceAll('__NAME__', name)
    .replaceAll('__WIDTH__', m[1]).replaceAll('__HEIGHT__', m[2]).replaceAll('__FPS__', String(Number(fps))).replaceAll('__FRAMES__', String(Number(frames))));
  writeFileSync(cfg.root, lines.join('\n'));
  return {
    ok: true, name, file: rel(cfg, file), rig: rel(cfg, rigFile), root: rel(cfg, cfg.root),
    registered: { id: name, width: Number(m[1]), height: Number(m[2]), fps: Number(fps), frames: Number(frames) },
    next: [`skac ${name} --check`, `skac ${name} --story`, `skac ${name} --verify`],
  };
};
