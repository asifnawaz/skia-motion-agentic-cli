import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fail, levenshteinNear } from './util.js';

const skiaDir = (cfg) => {
  const dir = join(cfg.projectDir, 'node_modules', '@shopify', 'react-native-skia');
  if (!existsSync(join(dir, 'package.json'))) {
    fail('@shopify/react-native-skia is not installed in this project', 'run `npm install` in the project directory');
  }
  return dir;
};

const dts = (dir, out = []) => {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) dts(p, out);
    else if (e.endsWith('.d.ts')) out.push(p);
  }
  return out;
};

/** Text of the braces-balanced or `;`-terminated declaration that starts at `from`. */
const block = (text, from) => {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '(' || c === '<') depth++;
    else if (c === '}' || c === ')' || c === '>') depth--;
    else if (c === ';' && depth <= 0) return text.slice(from, i + 1);
    if (c === '}' && depth === 0 && /^(export\s+)?(declare\s+)?interface/.test(text.slice(from, from + 40))) return text.slice(from, i + 1);
  }
  return text.slice(from);
};

const load = (cfg) => {
  const dir = skiaDir(cfg);
  const src = join(dir, 'lib', 'typescript', 'src');
  if (!existsSync(src)) fail('react-native-skia type files not found', 'expected lib/typescript/src; check the installed version');
  const files = dts(src).map((p) => ({ p, text: readFileSync(p, 'utf8') }));
  const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  return { dir, src, files, version };
};

const components = (sk) => {
  const out = [];
  for (const f of sk.files.filter((x) => x.p.includes('/renderer/components/'))) {
    for (const m of f.text.matchAll(/export declare (?:const|function) ([A-Z]\w*)\b/g)) {
      out.push({ name: m[1], file: relative(sk.dir, f.p), start: m.index, text: f.text });
    }
  }
  return out;
};

const typeDecl = (sk, name) => {
  const re = new RegExp(`(?:export\\s+)?(?:declare\\s+)?(?:interface|type)\\s+${name}\\b`);
  for (const f of sk.files) {
    const m = re.exec(f.text);
    if (m) return { type: name, file: relative(sk.dir, f.p), text: block(f.text, m.index) };
  }
  return null;
};

export const schema = (cfg, name) => {
  const sk = load(cfg);
  const comps = components(sk);
  if (!name) {
    return {
      ok: true, skia_version: sk.version, count: comps.length,
      components: comps.map((c) => ({ name: c.name, file: c.file })),
      next: ['skac schema Group'],
    };
  }
  const c = comps.find((x) => x.name === name);
  if (!c) {
    const near = levenshteinNear(name, comps.map((x) => x.name));
    fail(`no Skia component ${JSON.stringify(name)}`, 'run `skac schema` for the list', near.length ? { did_you_mean: near } : {});
  }
  const declaration = block(c.text, c.start);
  const propsNames = [...declaration.matchAll(/\b([A-Z]\w*Props)\b/g)].map((m) => m[1]);
  const seen = new Set();
  const types = [];
  const queue = [...new Set(propsNames)].filter((t) => t !== 'SkiaProps');
  while (queue.length && types.length < 8) {
    const t = queue.shift();
    if (seen.has(t)) continue;
    seen.add(t);
    const d = typeDecl(sk, t);
    if (!d) continue;
    types.push(d);
    const ext = /extends\s+([^{]+)\{/.exec(d.text);
    if (ext) for (const m of ext[1].matchAll(/\b([A-Z]\w*)\b/g)) if (!['Omit', 'Pick', 'Partial'].includes(m[1])) queue.push(m[1]);
  }
  return { ok: true, name, file: c.file, declaration, props: types };
};
